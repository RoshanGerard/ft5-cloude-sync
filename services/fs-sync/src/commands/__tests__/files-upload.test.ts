// Unit tests for `files:upload` handler — the orchestration layer per
// migrate-upload-orchestration-out-of-engine §9. Each test pair below
// maps to a §9.X task pair in
// `openspec/changes/migrate-upload-orchestration-out-of-engine/tasks.md`.
//
// The handler is dependency-injected end-to-end (resolveClient, registry,
// fsSyncBus, randomUUID, now) so tests drive every external boundary
// through fakes. No real disk / network access. The upload handler is
// much shorter than `files-download.ts` — there's no retry loop, no
// resume / range, no integrity check, no disposition policy: just engine
// call + event emission.

import { describe, expect, it, vi } from "vitest";

import type {
  DatasourceClient,
  Target,
} from "@ft5/fs-datasource-engine";
import type {
  DatasourceFileEntry,
  DatasourceType,
  EventName,
} from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import { createUploadRegistry } from "../../uploads/registry.js";
import { createEventBus } from "../../events/event-bus.js";
import {
  makeFilesUploadHandler,
  type FilesUploadDeps,
} from "../files-upload.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeClient(
  overrides: Partial<DatasourceClient<DatasourceType>> = {},
): DatasourceClient<DatasourceType> {
  return {
    type: "google-drive",
    datasourceId: "ds-1",
    status: vi.fn(),
    testConnection: vi.fn(),
    authenticate: vi.fn(),
    listDirectory: vi.fn(),
    search: vi.fn(),
    getMetadata: vi.fn(),
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    deleteDirectory: vi.fn(),
    rename: vi.fn(),
    downloadFile: vi.fn(),
    getQuota: vi.fn(),
    ...overrides,
  } as unknown as DatasourceClient<DatasourceType>;
}

interface CapturedEvent {
  name: EventName;
  payload: unknown;
}

function captureFsSyncEvents(): {
  bus: ReturnType<typeof createEventBus>;
  events: CapturedEvent[];
} {
  const bus = createEventBus();
  const events: CapturedEvent[] = [];
  bus.subscribe((name, payload) => {
    events.push({ name, payload });
  });
  return { bus, events };
}

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

const sampleEntry: DatasourceFileEntry<"google-drive"> = {
  handle: "h-uploaded-1",
  kind: "file",
  name: "x.jpg",
  path: "/photos/x.jpg",
  size: 1024,
  mimeFamily: "image",
  modifiedAt: Date.parse("2026-05-06T00:00:00.000Z"),
  providerMetadata: {},
};

function makeDeps(
  override: Partial<FilesUploadDeps> = {},
): FilesUploadDeps {
  const registry = createUploadRegistry();
  const { bus } = captureFsSyncEvents();
  let counter = 0;
  return {
    resolveClient: async () => makeFakeClient(),
    registry,
    fsSyncBus: bus,
    randomUUID: () => `job-${++counter}`,
    now: () => 1_000_000,
    ...override,
  };
}

// Absolute source path that is platform-correct on both Windows and Unix.
// `node:path.isAbsolute` accepts e.g. `C:\local\photos\x.jpg` on Windows
// and `/local/photos/x.jpg` on Unix; we use the Unix form on both since
// the path-validator's "absolute" check is platform-dispatched and Unix
// passes regardless of host. Tests that exercise the relative-path
// rejection path use a clearly-relative `relative/path.jpg` literal.
const SOURCE_PATH =
  process.platform === "win32" ? "C:\\local\\photos\\x.jpg" : "/local/photos/x.jpg";
const TARGET_PATH = "/photos/x.jpg";

// ---------------------------------------------------------------------------
// §9.1 / §9.6 / §9.8 — happy path
// ---------------------------------------------------------------------------

describe("files:upload — happy path (§9.1, §9.6, §9.8)", () => {
  it("validates request, mints uploadJobId, calls engine.uploadFile, emits exactly one file-created on resolve, replies success", async () => {
    const registry = createUploadRegistry();
    const { bus, events } = captureFsSyncEvents();
    const uploadFile = vi.fn(async (): Promise<DatasourceFileEntry<DatasourceType>> => sampleEntry);
    const client = makeFakeClient({ uploadFile });
    const handler = makeFilesUploadHandler(
      makeDeps({
        resolveClient: async () => client,
        registry,
        fsSyncBus: bus,
        randomUUID: () => "job-A",
      }),
    );

    const result = await handler(
      {
        datasourceId: "ds-1",
        sourcePath: SOURCE_PATH,
        targetPath: TARGET_PATH,
        conflictPolicy: "overwrite",
      },
      ctx,
    );

    expect(result).toEqual({ ok: true, result: { uploadJobId: "job-A" } });
    expect(uploadFile).toHaveBeenCalledTimes(1);

    // Brief-pinned property: happy-path with zero engine onProgress
    // ticks emits EXACTLY one `uploading` (the synthetic initial 0%)
    // followed by exactly one terminal `file-created`. A future change
    // that adds a "final 100% on success" emit would double-count and
    // break this assertion.
    const uploadingEvents = events.filter((e) => e.name === "uploading");
    expect(uploadingEvents).toHaveLength(1);
    expect(uploadingEvents[0]?.payload).toMatchObject({
      uploadJobId: "job-A",
      bytesUploaded: 0,
      bytesTotal: null,
    });
    // Engine receives `parent` = directory of targetPath; `file.name` =
    // basename. The engine's `uploadFile` is called with three args:
    // (parent: Target, file: { path, name?, mimeType? }, options?).
    const callArgs = uploadFile.mock.calls[0]!;
    expect(callArgs[0]).toEqual({ kind: "path", path: "/photos" } as Target);
    expect(callArgs[1]).toMatchObject({
      path: SOURCE_PATH,
      name: "x.jpg",
    });
    // Options carry the AbortSignal and onProgress.
    const options = callArgs[2] as
      | { signal?: AbortSignal; onProgress?: unknown }
      | undefined;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(typeof options?.onProgress).toBe("function");

    // Registry is empty post-resolve.
    expect(registry.size()).toBe(0);

    // Exactly one terminal `file-created` fires.
    const fileCreated = events.filter((e) => e.name === "file-created");
    expect(fileCreated).toHaveLength(1);
    expect(fileCreated[0]?.payload).toEqual({
      uploadJobId: "job-A",
      datasourceId: "ds-1",
      targetPath: TARGET_PATH,
      handle: "h-uploaded-1",
    });
    // No upload-failed / upload-cancelled.
    expect(events.filter((e) => e.name === "upload-failed")).toHaveLength(0);
    expect(events.filter((e) => e.name === "upload-cancelled")).toHaveLength(0);
  });

  it("emits the initial 0% uploading event before the engine starts streaming", async () => {
    // Per the brief: always emit the initial 0% unconditionally (mirror
    // download's pattern). The handler emits a synthetic `uploading`
    // with bytesUploaded: 0 BEFORE the engine call returns its first
    // onProgress tick.
    const releaseGate = vi.fn();
    let onProgressCb:
      | ((loaded: number, total: number) => void)
      | undefined;
    const uploadFile = vi.fn(
      (
        _parent: Target,
        _file: unknown,
        opts?: { onProgress?: (l: number, t: number) => void },
      ) => {
        onProgressCb = opts?.onProgress;
        return new Promise<DatasourceFileEntry<DatasourceType>>((resolve) => {
          // Hang until the test releases.
          releaseGate.mockImplementation(() => resolve(sampleEntry));
        });
      },
    );
    const client = makeFakeClient({ uploadFile });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesUploadHandler(
      makeDeps({
        resolveClient: async () => client,
        fsSyncBus: bus,
        randomUUID: () => "job-A",
      }),
    );
    const inflight = handler(
      {
        datasourceId: "ds-1",
        sourcePath: SOURCE_PATH,
        targetPath: TARGET_PATH,
        conflictPolicy: "overwrite",
      },
      ctx,
    );
    // Wait for the synchronous prelude + engine call kick-off.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const initialUploading = events.filter((e) => e.name === "uploading");
    expect(initialUploading.length).toBeGreaterThanOrEqual(1);
    expect(initialUploading[0]?.payload).toMatchObject({
      uploadJobId: "job-A",
      datasourceId: "ds-1",
      sourcePath: SOURCE_PATH,
      targetPath: TARGET_PATH,
      bytesUploaded: 0,
    });

    // Drive a couple of progress events through and release.
    onProgressCb?.(512, 1024);
    onProgressCb?.(1024, 1024);
    releaseGate();
    await inflight;
  });
});

// ---------------------------------------------------------------------------
// §9.7 — onProgress drives `uploading` events with throttle
// ---------------------------------------------------------------------------

describe("files:upload — onProgress throttle (§9.7)", () => {
  it("emits the FIRST progress tick unthrottled, throttles subsequent ticks until 1s elapsed OR 10% delta, emits the FINAL tick unthrottled", async () => {
    // The handler reads `deps.now()`, not `Date.now()`, so we drive
    // time via a closure-scoped `nowMs` rather than vi.useFakeTimers().
    {
      let onProgressCb:
        | ((loaded: number, total: number) => void)
        | undefined;
      let resolveUpload: (e: DatasourceFileEntry<DatasourceType>) => void = () => undefined;
      const uploadFile = vi.fn(
        (
          _parent: Target,
          _file: unknown,
          opts?: { onProgress?: (l: number, t: number) => void },
        ) => {
          onProgressCb = opts?.onProgress;
          return new Promise<DatasourceFileEntry<DatasourceType>>((resolve) => {
            resolveUpload = resolve;
          });
        },
      );
      const client = makeFakeClient({ uploadFile });
      const { bus, events } = captureFsSyncEvents();

      // Now() advances each call so the throttle's "1s elapsed" branch
      // can be exercised. Tests drive `now` directly so we don't depend
      // on real clock time.
      let nowMs = 1_000_000;
      const handler = makeFilesUploadHandler(
        makeDeps({
          resolveClient: async () => client,
          fsSyncBus: bus,
          now: () => nowMs,
          randomUUID: () => "job-A",
        }),
      );

      const inflight = handler(
        {
          datasourceId: "ds-1",
          sourcePath: SOURCE_PATH,
          targetPath: TARGET_PATH,
          conflictPolicy: "overwrite",
        },
        ctx,
      );
      // Let the synchronous prelude run and the upload call park on the gate.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Initial 0% tick already emitted (handler emits synthetically
      // BEFORE the engine call).
      const initialUploading = events.filter((e) => e.name === "uploading");
      expect(initialUploading.length).toBe(1);

      // Progress tick #1 — first one through the engine onProgress
      // callback. The throttle's "first call" branch emits unconditionally
      // (the initial 0% emission set the seed). Total bytes = 1000; 5%
      // delta is below the 10% threshold, so the throttle SHOULD swallow
      // this if it isn't the first onProgress tick. Pick a delta of 5%
      // and bump time by 100ms — both gates are below threshold.
      onProgressCb?.(50, 1000); // 5%
      // Throttled out — should NOT emit a new event.
      // (Initial 0% is the seed for the "% threshold" check.)
      expect(events.filter((e) => e.name === "uploading").length).toBe(1);

      // Progress tick #2 — cross the 10% delta from the seed (0% → 11%).
      onProgressCb?.(110, 1000); // 11%
      expect(events.filter((e) => e.name === "uploading").length).toBe(2);
      const second = events.filter((e) => e.name === "uploading")[1];
      expect(second?.payload).toMatchObject({
        bytesUploaded: 110,
        bytesTotal: 1000,
      });

      // Progress tick #3 — small delta (12%, only 1% from the last
      // emit) but advance time by >= 1s. Throttle's time gate fires.
      nowMs += 1_500;
      onProgressCb?.(120, 1000);
      expect(events.filter((e) => e.name === "uploading").length).toBe(3);

      // Progress tick #4 — small delta AND small time delta. Throttle
      // suppresses.
      nowMs += 100;
      onProgressCb?.(125, 1000);
      expect(events.filter((e) => e.name === "uploading").length).toBe(3);

      // Final 100% tick — handler emits unthrottled.
      onProgressCb?.(1000, 1000);
      const uploadingNow = events.filter((e) => e.name === "uploading");
      expect(uploadingNow.length).toBe(4);
      expect(uploadingNow[3]?.payload).toMatchObject({
        bytesUploaded: 1000,
        bytesTotal: 1000,
      });

      // Resolve the engine call. file-created fires.
      resolveUpload(sampleEntry);
      await inflight;
    }
  });

  it("onProgress callback updates registry entry's bytesUploaded and contentLength", async () => {
    let onProgressCb:
      | ((loaded: number, total: number) => void)
      | undefined;
    let resolveUpload: (e: DatasourceFileEntry<DatasourceType>) => void = () => undefined;
    const uploadFile = vi.fn(
      (
        _parent: Target,
        _file: unknown,
        opts?: { onProgress?: (l: number, t: number) => void },
      ) => {
        onProgressCb = opts?.onProgress;
        return new Promise<DatasourceFileEntry<DatasourceType>>((resolve) => {
          resolveUpload = resolve;
        });
      },
    );
    const client = makeFakeClient({ uploadFile });
    const registry = createUploadRegistry();
    const handler = makeFilesUploadHandler(
      makeDeps({
        resolveClient: async () => client,
        registry,
        randomUUID: () => "job-A",
      }),
    );
    const inflight = handler(
      {
        datasourceId: "ds-1",
        sourcePath: SOURCE_PATH,
        targetPath: TARGET_PATH,
        conflictPolicy: "overwrite",
      },
      ctx,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.get("job-A")?.bytesUploaded).toBe(0);
    onProgressCb?.(512, 1024);
    expect(registry.get("job-A")?.bytesUploaded).toBe(512);
    expect(registry.get("job-A")?.contentLength).toBe(1024);
    onProgressCb?.(1024, 1024);
    expect(registry.get("job-A")?.bytesUploaded).toBe(1024);

    resolveUpload(sampleEntry);
    await inflight;
    // Post-resolve, registry is cleared.
    expect(registry.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §9.10 — engine network error → upload-failed event + reject envelope
// ---------------------------------------------------------------------------

describe("files:upload — engine error (§9.10)", () => {
  it("on engine reject with non-cancelled tag: emits exactly one upload-failed; replies error envelope; clears registry", async () => {
    const uploadFile = vi.fn(async () => {
      throw new DatasourceError({
        tag: "network-error",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: true,
        message: "tcp reset",
      });
    });
    const client = makeFakeClient({ uploadFile });
    const registry = createUploadRegistry();
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesUploadHandler(
      makeDeps({
        resolveClient: async () => client,
        registry,
        fsSyncBus: bus,
        randomUUID: () => "job-A",
      }),
    );

    const result = await handler(
      {
        datasourceId: "ds-1",
        sourcePath: SOURCE_PATH,
        targetPath: TARGET_PATH,
        conflictPolicy: "overwrite",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.tag).toBe("disconnected"); // network-error → disconnected via normalizeFilesError
    expect(result.error.message).toContain("tcp reset");
    expect(result.error.retryable).toBe(true);

    // Exactly one upload-failed; no file-created or upload-cancelled.
    const failed = events.filter((e) => e.name === "upload-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({
      uploadJobId: "job-A",
      datasourceId: "ds-1",
      targetPath: TARGET_PATH,
      tag: "disconnected",
    });
    expect(events.filter((e) => e.name === "file-created")).toHaveLength(0);
    expect(events.filter((e) => e.name === "upload-cancelled")).toHaveLength(0);

    // Registry cleared.
    expect(registry.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §9.9 — mid-upload cancel → upload-cancelled + cleanup
// ---------------------------------------------------------------------------

describe("files:upload — cancel (§9.9)", () => {
  it("on engine reject tag === 'cancelled': emits one upload-cancelled; replies cancelled envelope; clears registry", async () => {
    let onProgressCb:
      | ((loaded: number, total: number) => void)
      | undefined;
    let receivedSignal: AbortSignal | undefined;
    const uploadFile = vi.fn(
      async (
        _parent: Target,
        _file: unknown,
        opts?: {
          signal?: AbortSignal;
          onProgress?: (l: number, t: number) => void;
        },
      ) => {
        onProgressCb = opts?.onProgress;
        receivedSignal = opts?.signal;
        // Drive a partial-progress tick so the cancelled event payload
        // carries non-zero bytesUploaded.
        opts?.onProgress?.(256, 1024);
        // Park until the signal fires.
        return new Promise<DatasourceFileEntry<DatasourceType>>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(
              new DatasourceError({
                tag: "cancelled",
                datasourceType: "google-drive",
                datasourceId: "ds-1",
                retryable: false,
                message: "user cancelled",
              }),
            );
          });
        });
      },
    );
    const client = makeFakeClient({ uploadFile });
    const registry = createUploadRegistry();
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesUploadHandler(
      makeDeps({
        resolveClient: async () => client,
        registry,
        fsSyncBus: bus,
        randomUUID: () => "job-A",
      }),
    );

    const inflight = handler(
      {
        datasourceId: "ds-1",
        sourcePath: SOURCE_PATH,
        targetPath: TARGET_PATH,
        conflictPolicy: "overwrite",
      },
      ctx,
    );
    // Wait for the upload to be in-flight.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.size()).toBe(1);
    expect(receivedSignal).toBeDefined();

    // Drive cancel through the registry's stored AbortController.
    const entry = registry.get("job-A")!;
    entry.abortController.abort();

    const result = await inflight;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.tag).toBe("cancelled");
    expect(result.error.retryable).toBe(false);

    const cancelled = events.filter((e) => e.name === "upload-cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.payload).toMatchObject({
      uploadJobId: "job-A",
      datasourceId: "ds-1",
      sourcePath: SOURCE_PATH,
      targetPath: TARGET_PATH,
      bytesUploaded: 256,
      reason: "user",
    });
    expect(events.filter((e) => e.name === "upload-failed")).toHaveLength(0);
    expect(events.filter((e) => e.name === "file-created")).toHaveLength(0);

    expect(registry.size()).toBe(0);
    void onProgressCb;
  });
});

// ---------------------------------------------------------------------------
// §9.3 / Decision 10 — concurrent-target rejection
// ---------------------------------------------------------------------------

describe("files:upload — concurrent-target rejection (§9.3, Decision 10)", () => {
  it("rejects a second files:upload to the same (datasourceId, targetPath) with tag: conflict BEFORE invoking engine", async () => {
    const uploadFile = vi.fn(
      () => new Promise<DatasourceFileEntry<DatasourceType>>(() => undefined),
    );
    const client = makeFakeClient({ uploadFile });
    const registry = createUploadRegistry();
    const { bus, events } = captureFsSyncEvents();
    let counter = 0;
    const handler = makeFilesUploadHandler(
      makeDeps({
        resolveClient: async () => client,
        registry,
        fsSyncBus: bus,
        randomUUID: () => `job-${++counter}`,
      }),
    );

    // First upload — hangs in flight.
    const inflightFirst = handler(
      {
        datasourceId: "ds-1",
        sourcePath: SOURCE_PATH,
        targetPath: TARGET_PATH,
        conflictPolicy: "overwrite",
      },
      ctx,
    );
    inflightFirst.catch(() => undefined);
    // Wait for the registry to insert the first entry.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.size()).toBe(1);
    expect(registry.findByTarget("ds-1", TARGET_PATH)).toBe("job-1");

    // Second upload — same (datasourceId, targetPath) — must be rejected.
    const result = await handler(
      {
        datasourceId: "ds-1",
        sourcePath: SOURCE_PATH,
        targetPath: TARGET_PATH,
        conflictPolicy: "overwrite",
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.tag).toBe("conflict");
    expect(result.error.retryable).toBe(false);
    expect(result.error.existingUploadJobId).toBe("job-1");
    expect(result.error.existingPath).toBe(TARGET_PATH);

    // Engine was called once (for the first upload only).
    expect(uploadFile).toHaveBeenCalledTimes(1);
    // First upload's progress is unaffected.
    expect(registry.size()).toBe(1);
    // No conflict-related events fire — the rejection is a synchronous
    // reply, not a lifecycle event.
    expect(events.filter((e) => e.name === "upload-failed")).toHaveLength(0);
  });

  it("rejects a different sourcePath uploading to the same target slot (rejection key = target only)", async () => {
    const uploadFile = vi.fn(
      () => new Promise<DatasourceFileEntry<DatasourceType>>(() => undefined),
    );
    const client = makeFakeClient({ uploadFile });
    const registry = createUploadRegistry();
    let counter = 0;
    const handler = makeFilesUploadHandler(
      makeDeps({
        resolveClient: async () => client,
        registry,
        randomUUID: () => `job-${++counter}`,
      }),
    );

    const sourcePath2 =
      process.platform === "win32" ? "C:\\local\\b.jpg" : "/local/b.jpg";

    const inflightFirst = handler(
      {
        datasourceId: "ds-1",
        sourcePath: SOURCE_PATH,
        targetPath: TARGET_PATH,
        conflictPolicy: "overwrite",
      },
      ctx,
    );
    inflightFirst.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const result = await handler(
      {
        datasourceId: "ds-1",
        sourcePath: sourcePath2, // DIFFERENT source.
        targetPath: TARGET_PATH, // SAME target.
        conflictPolicy: "overwrite",
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.tag).toBe("conflict");
    expect(result.error.existingUploadJobId).toBe("job-1");

    // Engine call still only once.
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it("allows the same target on a different datasourceId — both succeed", async () => {
    let counter = 0;
    const uploadFile = vi.fn(async () => sampleEntry);
    const client = makeFakeClient({ uploadFile });
    const registry = createUploadRegistry();
    const handler = makeFilesUploadHandler(
      makeDeps({
        resolveClient: async () => client,
        registry,
        randomUUID: () => `job-${++counter}`,
      }),
    );

    const r1 = await handler(
      {
        datasourceId: "ds-1",
        sourcePath: SOURCE_PATH,
        targetPath: TARGET_PATH,
        conflictPolicy: "overwrite",
      },
      ctx,
    );
    const r2 = await handler(
      {
        datasourceId: "ds-2",
        sourcePath: SOURCE_PATH,
        targetPath: TARGET_PATH,
        conflictPolicy: "overwrite",
      },
      ctx,
    );

    expect(r1).toEqual({ ok: true, result: { uploadJobId: "job-1" } });
    expect(r2).toEqual({ ok: true, result: { uploadJobId: "job-2" } });
    expect(uploadFile).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// §9.2 — input validation
// ---------------------------------------------------------------------------

describe("files:upload — input validation (§9.2)", () => {
  it("rejects with tag: 'other' when sourcePath is relative", async () => {
    const uploadFile = vi.fn();
    const client = makeFakeClient({ uploadFile });
    const handler = makeFilesUploadHandler(
      makeDeps({ resolveClient: async () => client }),
    );

    const result = await handler(
      {
        datasourceId: "ds-1",
        sourcePath: "relative/photo.jpg", // not absolute
        targetPath: TARGET_PATH,
        conflictPolicy: "overwrite",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.tag).toBe("other");
    expect(result.error.message).toMatch(/sourcePath/i);
    expect(result.error.retryable).toBe(false);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("rejects with tag: 'other' when targetPath is empty / has no filename", async () => {
    const uploadFile = vi.fn();
    const client = makeFakeClient({ uploadFile });
    const handler = makeFilesUploadHandler(
      makeDeps({ resolveClient: async () => client }),
    );

    const result = await handler(
      {
        datasourceId: "ds-1",
        sourcePath: SOURCE_PATH,
        targetPath: "/photos/", // trailing slash — no filename
        conflictPolicy: "overwrite",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.tag).toBe("other");
    expect(result.error.message).toMatch(/targetPath/i);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("rejects with tag: 'other' when targetPath is not absolute", async () => {
    const uploadFile = vi.fn();
    const client = makeFakeClient({ uploadFile });
    const handler = makeFilesUploadHandler(
      makeDeps({ resolveClient: async () => client }),
    );

    const result = await handler(
      {
        datasourceId: "ds-1",
        sourcePath: SOURCE_PATH,
        targetPath: "photos/x.jpg", // not absolute (no leading /)
        conflictPolicy: "overwrite",
      },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.tag).toBe("other");
    expect(result.error.message).toMatch(/targetPath/i);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
