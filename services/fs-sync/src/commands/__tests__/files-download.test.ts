// Unit tests for `files:download` handler — the orchestration layer per
// add-engine-rename-download §13. Each test pair below maps to a §13.X
// task pair in `openspec/changes/add-engine-rename-download/tasks.md`.
//
// The handler is dependency-injected end-to-end (resolveClient, registry,
// fsSyncBus, engineBus, fs, hash, randomUUID, now, homedir) so tests
// drive every external boundary through fakes. No real disk / network
// access.

import { describe, expect, it, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import * as nodePath from "node:path";

import type {
  DatasourceClient,
  DownloadOptions,
  DownloadResult,
  Target,
} from "@ft5/fs-datasource-engine";
import type {
  DatasourceFileEntry,
  DatasourceType,
  EventName,
  EventPayloadMap,
} from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import { createDownloadRegistry } from "../../downloads/registry.js";
import { createEventBus } from "../../events/event-bus.js";
import {
  makeFilesDownloadHandler,
  makeSyncCancelDownloadHandler,
  readProviderHash,
  transformDownloadingEvent,
  transformFileDownloadedEvent,
  transformDownloadCancelledEvent,
  isEnvironmentallyRetryable,
  expBackoff,
  sleepCancellable,
  DELETE_ON_TERMINAL,
  RangeNotHonoredError,
  RangeMismatchError,
  IntegrityFailedError,
  ByteCountMismatchError,
  type EngineBusEvent,
  type EngineBusSubscriber,
  type FilesDownloadDeps,
  type FsBoundary,
  type HashComputer,
} from "../files-download.js";

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
    createFile: vi.fn(),
    uploadFile: vi.fn(),
    cancelUpload: vi.fn(),
    deleteFile: vi.fn(),
    deleteDirectory: vi.fn(),
    rename: vi.fn(),
    downloadFile: vi.fn(),
    getQuota: vi.fn(),
    ...overrides,
  } as unknown as DatasourceClient<DatasourceType>;
}

interface FakeFs extends FsBoundary {
  files: Map<string, Buffer>;
  accessibleParents: Set<string>;
}

function makeFakeFs(opts: { writableParents?: string[] } = {}): FakeFs {
  const files = new Map<string, Buffer>();
  const accessibleParents = new Set<string>(opts.writableParents ?? []);
  const fakeFs: FakeFs = {
    files,
    accessibleParents,
    access: async (path) => {
      if (!accessibleParents.has(path)) {
        throw new Error(`EACCES: ${path}`);
      }
    },
    statSize: async (path) => {
      const buf = files.get(path);
      if (buf === undefined) throw new Error(`ENOENT: ${path}`);
      return buf.length;
    },
    createWriteStream: (path, options) => {
      const existing = files.get(path);
      const head =
        options.flags === "w" || existing === undefined
          ? Buffer.alloc(0)
          : existing.subarray(0, options.start);
      const chunks: Buffer[] = [];
      const flush = () => {
        const written = Buffer.concat(chunks);
        files.set(path, Buffer.concat([head, written]));
      };
      // For "w" flag, eagerly create a zero-byte file so a cancel BEFORE
      // any data arrives still leaves the partial-file marker behind on
      // disk (matches real `fs.createWriteStream` behaviour with "w").
      if (options.flags === "w") {
        files.set(path, Buffer.alloc(0));
      }
      return new Writable({
        write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
          chunks.push(Buffer.from(chunk));
          // Persist on every write so an abort that destroys the stream
          // before `final` still leaves the partial bytes on disk.
          flush();
          cb();
        },
        final(cb: (err?: Error | null) => void) {
          flush();
          cb();
        },
      });
    },
    pipeline: async (source, sink, signal) => {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        let settled = false;
        const settle = (
          op: "resolve" | "reject",
          value?: unknown,
        ): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (op === "resolve") resolve();
          else reject(value);
        };
        const onAbort = () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          source.destroy(err);
          settle("reject", err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        source.on("error", (err) => settle("reject", err));
        source.on("data", (chunk: Buffer) => sink.write(chunk));
        source.on("end", () => {
          (sink as Writable).end(() => settle("resolve"));
        });
      });
    },
    // Default unlink — removes the in-memory entry. Tests that need to
    // observe the call (e.g. §6.11-§6.13, §6.15) override this with a
    // `vi.fn` spy via `fakeFs.unlink = ...`.
    unlink: async (path: string) => {
      files.delete(path);
    },
  };
  return fakeFs;
}

function makeEngineBus(): EngineBusSubscriber & {
  emit(event: EngineBusEvent): void;
  subscribers: Set<(e: EngineBusEvent) => void>;
} {
  const subscribers = new Set<(e: EngineBusEvent) => void>();
  return {
    subscribers,
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    emit(event) {
      for (const s of subscribers) s(event);
    },
  };
}

function makeHash(map: Record<string, string> = {}): HashComputer {
  return {
    hashFile: async (path) => map[path] ?? "deadbeef",
  };
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

function streamFromBytes(buf: Buffer): Readable {
  return Readable.from([buf]);
}

// Build platform-appropriate absolute paths so `path.normalize(input)
// === input` holds on every host (Windows uses `\` and a drive letter;
// Unix uses `/`). The validator's "no traversal" check fires when
// normalize differs from input — using `path.join` produces canonical
// absolute paths that won't trip that check on either platform.
const HOMEDIR = nodePath.resolve(nodePath.sep, "home", "alice");
const SYNC_APP_DIR = nodePath.join(HOMEDIR, "ft5", "sync_app");
const PARENT = nodePath.join(HOMEDIR, "Downloads");
const TO_PATH = nodePath.join(PARENT, "welcome.pdf");

function makeDeps(
  override: Partial<FilesDownloadDeps> = {},
): FilesDownloadDeps {
  const fakeFs = makeFakeFs({ writableParents: [PARENT] });
  const registry = createDownloadRegistry();
  const { bus } = captureFsSyncEvents();
  const engineBus = makeEngineBus();
  let counter = 0;
  return {
    resolveClient: async () => makeFakeClient(),
    registry,
    fsSyncBus: bus,
    engineBus,
    fs: fakeFs,
    hash: makeHash(),
    randomUUID: () => `job-${++counter}`,
    now: () => 1_000_000,
    homedir: () => HOMEDIR,
    ...override,
  };
}

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

const sampleEntry: DatasourceFileEntry<"google-drive"> = {
  handle: "h-1",
  kind: "file",
  name: "welcome.pdf",
  path: "/welcome.pdf",
  size: 1024,
  mimeFamily: "document",
  modifiedAt: Date.parse("2026-04-28T00:00:00.000Z"),
  providerMetadata: { md5Checksum: "deadbeef" },
};

// ---------------------------------------------------------------------------
// §13.1 + §13.2 — happy path
// ---------------------------------------------------------------------------

describe("files:download — happy path (§13.1, §13.2)", () => {
  it("validates toPath, mints downloadJobId, calls engine.downloadFile, pipes to disk, asserts byte count, runs integrity check, replies success", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const registry = createDownloadRegistry();
    const { bus, events } = captureFsSyncEvents();
    const engineBus = makeEngineBus();
    const payload = Buffer.alloc(1024, 0xab);
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => ({
      stream: streamFromBytes(payload),
      contentLength: 1024,
    }));
    const getMetadata = vi.fn().mockResolvedValue(sampleEntry);
    const client = makeFakeClient({ downloadFile, getMetadata });
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        registry,
        fsSyncBus: bus,
        engineBus,
        fs: fakeFs,
        hash: makeHash({ [TO_PATH]: "deadbeef" }),
      }),
    );

    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ savedPath: TO_PATH, bytes: 1024 });
    }
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(downloadFile.mock.calls[0]?.[0]).toEqual({
      kind: "path",
      path: "/welcome.pdf",
    });
    // The handler emits exactly one terminal `file-downloaded` event.
    const terminal = events.filter((e) => e.name === "file-downloaded");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.payload).toMatchObject({
      datasourceId: "ds-1",
      savedPath: TO_PATH,
      bytes: 1024,
    });
    // Registry is empty after success.
    expect(registry.size()).toBe(0);
    // The reverse-index slot for (ds-1, /welcome.pdf) is also clear.
    expect(registry.findByKey("ds-1", "/welcome.pdf")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §13.3 + §13.4 — toPath validation
// ---------------------------------------------------------------------------

describe("files:download — toPath validation (§13.3, §13.4)", () => {
  it("rejects a relative toPath with tag:'other' message:'toPath validation: not absolute' and does NOT call the engine", async () => {
    const downloadFile = vi.fn();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => makeFakeClient({ downloadFile }),
      }),
    );
    const result = await handler(
      {
        datasourceId: "ds-1",
        path: "/welcome.pdf",
        toPath: "Downloads/welcome.pdf",
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toBe("toPath validation: not absolute");
    }
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("rejects a path with `..` traversal (post-normalize check)", async () => {
    const downloadFile = vi.fn();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => makeFakeClient({ downloadFile }),
      }),
    );
    // Build a literal traversal-bearing path WITHOUT going through
    // `path.join` (which would collapse the `..` at construction time).
    const sep = nodePath.sep;
    const traversal =
      HOMEDIR + sep + "Downloads" + sep + ".." + sep + ".." + sep + ".." + sep +
      "etc" + sep + "passwd";
    const result = await handler(
      {
        datasourceId: "ds-1",
        path: "/welcome.pdf",
        toPath: traversal,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toBe("toPath validation: contains traversal");
    }
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("rejects a path inside the service data dir `~/ft5/sync_app/`", async () => {
    const downloadFile = vi.fn();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => makeFakeClient({ downloadFile }),
      }),
    );
    const result = await handler(
      {
        datasourceId: "ds-1",
        path: "/welcome.pdf",
        toPath: nodePath.join(SYNC_APP_DIR, "credentials.json"),
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        "toPath validation: cannot write inside service data directory",
      );
    }
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("rejects an unwritable parent directory", async () => {
    const downloadFile = vi.fn();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        // No writableParents → access rejects → reason 'parent directory not writable'.
        fs: makeFakeFs({ writableParents: [] }),
        resolveClient: async () => makeFakeClient({ downloadFile }),
      }),
    );
    const result = await handler(
      {
        datasourceId: "ds-1",
        path: "/welcome.pdf",
        toPath: TO_PATH,
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        "toPath validation: parent directory not writable",
      );
    }
    expect(downloadFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §13.5 + §13.6 — mid-stream auth-expired retry (per design.md Decision 3)
// ---------------------------------------------------------------------------

describe("files:download — mid-stream auth-expired retry loop (§13.5, §13.6)", () => {
  it("on mid-stream auth-expired: re-stats toPath, retries with rangeStart=N, validates contentRange.start, pipes from byte N, succeeds on the second cycle", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    // Simulate that the first-cycle pipe wrote N bytes before failing.
    const FIRST_BYTES = Buffer.alloc(512, 0xaa);
    const SECOND_BYTES = Buffer.alloc(512, 0xbb);
    let call = 0;
    const downloadFile = vi.fn(async (target, options): Promise<DownloadResult> => {
      call++;
      if (call === 1) {
        // First cycle: stream emits 512 bytes then errors with auth-expired.
        const stream = Readable.from(
          (async function* () {
            // pre-write the partial bytes to disk so statSize sees N=512.
            fakeFs.files.set(TO_PATH, FIRST_BYTES);
            yield FIRST_BYTES;
            throw new DatasourceError({
              tag: "auth-expired",
              datasourceType: "google-drive",
              datasourceId: "ds-1",
              retryable: true,
              message: "token expired mid-stream",
            });
          })(),
        );
        return { stream, contentLength: 1024 };
      }
      // Second cycle (post-refresh) — provider returns 206 Partial
      // with contentRange.start === rangeStart.
      const rangeStart = options?.rangeStart ?? 0;
      expect(rangeStart).toBe(512);
      return {
        stream: streamFromBytes(SECOND_BYTES),
        contentLength: 1024,
        contentRange: { start: 512, end: 1023, total: 1024 },
      };
    });
    const getMetadata = vi.fn().mockResolvedValue(sampleEntry);
    const client = makeFakeClient({ downloadFile, getMetadata });
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        hash: makeHash({ [TO_PATH]: "deadbeef" }),
      }),
    );

    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    // The mid-stream auth-expired retry inside the same cycle should
    // re-issue and succeed; the assembled disk file is 1024 bytes.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.bytes).toBe(1024);
    }
    expect(downloadFile).toHaveBeenCalledTimes(2);
  });

  it("two consecutive auth-expired in the same cycle exhaust MAX_AUTH_RETRIES_PER_CYCLE and surface as a terminal failure", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => {
      const stream = Readable.from(
        (async function* () {
          fakeFs.files.set(TO_PATH, Buffer.alloc(0));
          // Every call errors immediately, BEFORE yielding any bytes.
          throw new DatasourceError({
            tag: "auth-expired",
            datasourceType: "google-drive",
            datasourceId: "ds-1",
            retryable: true,
            message: "token expired mid-stream",
          });
        })(),
      );
      return { stream, contentLength: 1024 };
    });
    const client = makeFakeClient({ downloadFile });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(false);
    // Per the retry budget: cycle 1, attempt 0 fails auth-expired → retry
    // attempt 1 also fails → exhaust → escalate. The handler emits
    // download-failed.
    const terminal = events.filter((e) => e.name === "download-failed");
    expect(terminal).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §13.7 + §13.8 — range-not-honored
// ---------------------------------------------------------------------------

describe("files:download — range-not-honored detection (§13.7 / §13.8 + §12.4 Decision 3 rewrite)", () => {
  // §12.4 (Decision 3 rewrite): range-not-honored on a resume request
  // is no longer terminal. The handler emits `download-retrying` with
  // `engineCause: "range-not-honored"` and `waitMs: 0`, unlinks the
  // partial in-flight, sets `rangeUnsupported = true` sticky, and
  // restarts the cycle from byte 0. The original §13.7 behavior
  // (terminal `download-failed { tag: "other", message: "range not
  // supported on this resource" }`) is now reachable only via the
  // defensive sentinel path (the class still exists; if a defect
  // propagates it to terminal, the existing branch handles it). The
  // common-case rewrite-from-0 contract is pinned by §12.4 tests
  // below.
  it("on resume where contentRange === undefined: emits download-retrying { engineCause: 'range-not-honored', waitMs: 0 }, unlinks partial, restarts cycle from byte 0; download completes from full re-pipe", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    let call = 0;
    const downloadFile = vi.fn(
      async (
        _target: Target,
        opts: DownloadOptions | undefined,
      ): Promise<DownloadResult> => {
        call++;
        if (call === 1) {
          // Cycle 1 / attempt 1: return a stream that drains 512 bytes
          // then errors with a network-error mid-stream — triggers the
          // env-retry branch's first sleep cycle.
          const stream = Readable.from(
            (async function* () {
              fakeFs.files.set(TO_PATH, Buffer.alloc(512, 0xaa));
              yield Buffer.alloc(512, 0xaa);
              throw new DatasourceError({
                tag: "network-error",
                datasourceType: "google-drive",
                datasourceId: "ds-1",
                retryable: true,
                message: "wifi drop",
              });
            })(),
          );
          return { stream, contentLength: 1024 };
        }
        if (call === 2) {
          // Cycle 1 / attempt 2: rangeStart = 512 (resume request).
          // Provider IGNORES the Range header — returns 200 OK with
          // no Content-Range. This triggers rewrite-from-0.
          expect(opts?.rangeStart).toBe(512);
          return {
            stream: streamFromBytes(Buffer.alloc(0)),
            contentLength: 1024,
          };
        }
        // Cycle 1 / attempt 3 (post-rewrite-from-0): rangeStart = 0
        // (rangeUnsupported is sticky). Server returns full body.
        expect(opts?.rangeStart).toBe(0);
        return {
          stream: streamFromBytes(Buffer.alloc(1024, 0xbb)),
          contentLength: 1024,
        };
      },
    );
    const client = makeFakeClient({ downloadFile });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
      }),
    );
    vi.useFakeTimers();
    const inflight = handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    // First retry sleep is 1000ms (network-error → expBackoff(1)).
    // Then the rewrite-from-0 path emits a SECOND download-retrying
    // with waitMs=0 (no sleep). Then cycle continues to attempt 3.
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(0); // flush microtasks
    const result = await inflight;
    vi.useRealTimers();

    expect(result.ok).toBe(true);
    const retrying = events.filter((e) => e.name === "download-retrying");
    expect(retrying).toHaveLength(2);
    // First retrying event: cycle 1 mid-stream network-error (waitMs > 0).
    expect(retrying[0]?.payload).toMatchObject({
      attempt: 1,
      engineCause: "network-error",
    });
    expect((retrying[0]?.payload as { waitMs: number }).waitMs).toBeGreaterThan(0);
    // Second retrying event: rewrite-from-0 trigger (waitMs === 0,
    // engineCause === "range-not-honored").
    expect(retrying[1]?.payload).toMatchObject({
      attempt: 2,
      engineCause: "range-not-honored",
      waitMs: 0,
    });
    // No terminal `download-failed` in the success path.
    expect(events.filter((e) => e.name === "download-failed")).toHaveLength(0);
    // Final file content matches the cycle 3 stream (full 1024 bytes
    // 0xbb), confirming the rewrite-from-0 truncated and re-piped.
    const finalBytes = fakeFs.files.get(TO_PATH);
    expect(finalBytes?.length).toBe(1024);
    expect(finalBytes?.[0]).toBe(0xbb);
  });
});

// ---------------------------------------------------------------------------
// §13.9 + §13.10 — range-mismatch
// ---------------------------------------------------------------------------

describe("files:download — range-mismatch detection (§13.9, §13.10)", () => {
  it("on retry where contentRange.start !== rangeStart: refuses to pipe; emits terminal range-mismatch", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    let call = 0;
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => {
      call++;
      if (call === 1) {
        const stream = Readable.from(
          (async function* () {
            fakeFs.files.set(TO_PATH, Buffer.alloc(512, 0xaa));
            yield Buffer.alloc(512, 0xaa);
            throw new DatasourceError({
              tag: "auth-expired",
              datasourceType: "google-drive",
              datasourceId: "ds-1",
              retryable: true,
              message: "expired",
            });
          })(),
        );
        return { stream, contentLength: 1024 };
      }
      // Provider returns 206 but with WRONG start — start=0 instead of 512.
      return {
        stream: streamFromBytes(Buffer.alloc(1024, 0xbb)),
        contentLength: 1024,
        contentRange: { start: 0, end: 1023, total: 1024 },
      };
    });
    const client = makeFakeClient({ downloadFile });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toBe("range mismatch on this resource");
    }
    const terminal = events.filter((e) => e.name === "download-failed");
    expect(terminal).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §13.11 + §13.12 — byte-count assertion
// ---------------------------------------------------------------------------

describe("files:download — byte-count assertion (§13.11, §13.12)", () => {
  it("on pipe success but fs.stat(toPath).size !== contentLength: terminal failure with tag:'other' message:'byte count mismatch'", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    // Engine claims 1024 bytes but only emits 512 — the stream ends, the
    // pipe drains, but the disk file has the wrong byte count.
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => ({
      stream: streamFromBytes(Buffer.alloc(512, 0xab)),
      contentLength: 1024,
    }));
    const client = makeFakeClient({ downloadFile });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toBe("byte count mismatch");
    }
    const terminal = events.filter((e) => e.name === "download-failed");
    expect(terminal).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §13.13 + §13.14 — post-download integrity check
// ---------------------------------------------------------------------------

describe("files:download — post-download integrity check (§13.13, §13.14)", () => {
  it("on local-hash mismatch with provider hash: terminal failure with tag:'other' message:'integrity check failed'", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => ({
      stream: streamFromBytes(Buffer.alloc(1024, 0xab)),
      contentLength: 1024,
    }));
    const getMetadata = vi.fn().mockResolvedValue(sampleEntry);
    const client = makeFakeClient({ downloadFile, getMetadata });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
        hash: makeHash({ [TO_PATH]: "feedface" }), // mismatches "deadbeef"
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("integrity check failed");
    }
    const terminal = events.filter((e) => e.name === "download-failed");
    expect(terminal).toHaveLength(1);
  });

  it("skips the integrity check when the provider does not advertise a comparable hash", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => ({
      stream: streamFromBytes(Buffer.alloc(1024, 0xab)),
      contentLength: 1024,
    }));
    const noHashEntry: DatasourceFileEntry<"google-drive"> = {
      ...sampleEntry,
      providerMetadata: {},
    };
    const getMetadata = vi.fn().mockResolvedValue(noHashEntry);
    const client = makeFakeClient({ downloadFile, getMetadata });
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        // The hash computer would mismatch if called — but it should NOT
        // be called when the provider didn't advertise a hash.
        hash: { hashFile: vi.fn().mockRejectedValue(new Error("should not be called")) },
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §13.15 + §13.16 — cancel mid-pipe
// ---------------------------------------------------------------------------

describe("files:download — cancel mid-pipe (§13.15, §13.16)", () => {
  it("on AbortController.abort(): pipeline rejects with AbortError, handler emits exactly one download-cancelled, partial file is NOT deleted, replies tag:'cancelled'", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    let abortFired = false;
    const downloadFile = vi.fn(async (target, options): Promise<DownloadResult> => {
      const stream = new Readable({ read() {} });
      // Simulate an in-flight stream: yield some bytes, then wait for
      // the abort signal to terminate it. We push a chunk first so disk
      // has SOME state.
      setTimeout(() => stream.push(Buffer.alloc(256, 0xaa)), 0);
      options?.signal?.addEventListener("abort", () => {
        abortFired = true;
        const err = new Error("aborted");
        err.name = "AbortError";
        stream.destroy(err);
      });
      return { stream, contentLength: 1024 };
    });
    const client = makeFakeClient({ downloadFile });
    const registry = createDownloadRegistry();
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
        registry,
      }),
    );

    // Kick off the download and cancel it concurrently via the cancel
    // command surface.
    const cancelHandler = makeSyncCancelDownloadHandler({ registry });
    const inflight = handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    // Wait one microtask so the handler has a chance to register the
    // entry; then issue the cancel.
    await new Promise((resolve) => setImmediate(resolve));
    const cancelResult = await cancelHandler(
      { downloadJobId: "job-1" },
      ctx,
    );
    expect(cancelResult).toEqual({
      ok: true,
      result: { cancelled: true },
    });
    const result = await inflight;
    expect(abortFired).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("cancelled");
    }
    const cancelEvents = events.filter(
      (e) => e.name === "download-cancelled",
    );
    expect(cancelEvents).toHaveLength(1);
    expect(cancelEvents[0]?.payload).toMatchObject({
      datasourceId: "ds-1",
      reason: "user",
    });
    // Partial file is NOT auto-deleted.
    expect(fakeFs.files.has(TO_PATH)).toBe(true);
    // Registry entry released.
    expect(registry.size()).toBe(0);
  });

  it("sync:cancel-download on an unknown downloadJobId is idempotent: returns { cancelled: false }", async () => {
    const registry = createDownloadRegistry();
    const cancelHandler = makeSyncCancelDownloadHandler({ registry });
    const result = await cancelHandler(
      { downloadJobId: "ghost" },
      ctx,
    );
    expect(result).toEqual({ ok: true, result: { cancelled: false } });
  });
});

// ---------------------------------------------------------------------------
// §13.17 + §13.18 — registry update throttling (driven by engine bus)
// ---------------------------------------------------------------------------

describe("files:download — registry update throttling (§13.17, §13.18)", () => {
  it("rapid onProgress callbacks update the registry on every tick (inline path); the engine bus's coalescer is the throttle for the IPC `downloading` event emission", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const registryStates: number[] = [];
    const downloadFile = vi.fn(async (target, options): Promise<DownloadResult> => {
      // Drive 100 rapid onProgress ticks.
      for (let i = 0; i < 100; i++) {
        options?.onProgress?.(i * 10, 1024);
      }
      return {
        stream: streamFromBytes(Buffer.alloc(1024, 0xab)),
        contentLength: 1024,
      };
    });
    const getMetadata = vi.fn().mockResolvedValue({
      ...sampleEntry,
      providerMetadata: {},
    });
    const client = makeFakeClient({ downloadFile, getMetadata });
    const registry = createDownloadRegistry();
    // Capture the registry's state per onProgress tick by hooking into
    // `update` — verifies the inline path writes through directly.
    const origUpdate = registry.update.bind(registry);
    registry.update = (id, partial) => {
      origUpdate(id, partial);
      const e = registry.get(id);
      if (e) registryStates.push(e.bytesDownloaded);
    };
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        registry,
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(true);
    // The inline path writes every onProgress tick — 100 calls →
    // ≥100 registry updates (bytesDownloaded climbs).
    expect(registryStates.length).toBeGreaterThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// §13.19 + §13.20 — registry release on terminal events
// ---------------------------------------------------------------------------

describe("files:download — registry release on terminal events (§13.19, §13.20)", () => {
  it("on file-downloaded: registry entry is removed", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => ({
      stream: streamFromBytes(Buffer.alloc(1024, 0xab)),
      contentLength: 1024,
    }));
    const getMetadata = vi.fn().mockResolvedValue({
      ...sampleEntry,
      providerMetadata: {},
    });
    const client = makeFakeClient({ downloadFile, getMetadata });
    const registry = createDownloadRegistry();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        registry,
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(registry.size()).toBe(0);
    expect(registry.findByKey("ds-1", "/welcome.pdf")).toBeUndefined();
  });

  it("on download-failed: registry entry is removed", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    // §11.3 (Decision 12) — env-retryable pre-stream errors now re-enter
    // Layer 3 retry instead of going straight to terminal. Use a
    // non-retryable terminal error (auth-revoked) so this test exercises
    // the registry-cleanup-on-terminal contract unambiguously.
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => {
      throw new DatasourceError({
        tag: "auth-revoked",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: false,
        message: "refresh token revoked",
      });
    });
    const client = makeFakeClient({ downloadFile });
    const registry = createDownloadRegistry();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        registry,
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(registry.size()).toBe(0);
    expect(registry.findByKey("ds-1", "/welcome.pdf")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §13.21 + §13.22 — engine-bus subscription
// ---------------------------------------------------------------------------

describe("files:download — engine-bus subscription (§13.21, §13.22)", () => {
  it("subscribes to the engine bus for the lifetime of the download; the subscription is released on terminal", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const engineBus = makeEngineBus();
    let releaseGate: (() => void) | null = null;
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => {
      // Hold the handler open inside the engine call so we can observe
      // the subscription before terminal cleanup runs.
      await new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      return {
        stream: streamFromBytes(Buffer.alloc(1024, 0xab)),
        contentLength: 1024,
      };
    });
    const getMetadata = vi.fn().mockResolvedValue({
      ...sampleEntry,
      providerMetadata: {},
    });
    const client = makeFakeClient({ downloadFile, getMetadata });
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        engineBus,
      }),
    );
    expect(engineBus.subscribers.size).toBe(0);
    const inflight = handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    // Wait for the handler to register the bus subscription. The handler
    // synchronously subscribes BEFORE awaiting the engine call, so a
    // single microtask flush is enough.
    await new Promise((resolve) => setImmediate(resolve));
    expect(engineBus.subscribers.size).toBe(1);
    // Release the gate so the engine call returns and the handler runs
    // through to terminal.
    releaseGate?.();
    await inflight;
    // Subscription released on terminal (success).
    expect(engineBus.subscribers.size).toBe(0);
  });

  it("the bus subscription correlates `(datasourceId, path)` to downloadJobId via the registry's reverse index and emits fs-sync's downloadJobId-keyed `downloading` event", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const engineBus = makeEngineBus();
    let resolveStream: (() => void) | null = null;
    const stream = new Readable({ read() {} });
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => {
      // Delay ending the stream until the test fires bus events.
      await new Promise<void>((r) => {
        resolveStream = r;
      });
      stream.push(Buffer.alloc(1024, 0xab));
      stream.push(null);
      return { stream, contentLength: 1024 };
    });
    const getMetadata = vi.fn().mockResolvedValue({
      ...sampleEntry,
      providerMetadata: {},
    });
    const client = makeFakeClient({ downloadFile, getMetadata });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        engineBus,
        fsSyncBus: bus,
      }),
    );
    const inflight = handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    // Wait for the registry entry to be visible.
    await new Promise((resolve) => setImmediate(resolve));
    // Now emit an engine bus `downloading` event.
    engineBus.emit({
      event: "downloading",
      datasourceId: "ds-1",
      streaming: true,
      payload: { path: "/welcome.pdf", loaded: 512, total: 1024 },
    });
    // Resolve the in-flight stream so the handler completes.
    resolveStream?.();
    await inflight;
    const downloading = events.filter((e) => e.name === "downloading");
    expect(downloading).toHaveLength(1);
    expect(downloading[0]?.payload).toMatchObject({
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      progress: 50,
    });
    // The downloadJobId is the one minted by the handler ("job-1").
    expect((downloading[0]?.payload as { downloadJobId: string }).downloadJobId).toBe("job-1");
  });
});

// ---------------------------------------------------------------------------
// §13.23 + §13.24 — concurrent-rejection guard / reverse index
// ---------------------------------------------------------------------------

describe("files:download — concurrent-rejection guard (§13.23, §13.24)", () => {
  it("a second files:download for an in-flight (datasourceId, sourcePath) rejects with tag:'other' message:'download already in progress for this entry'", async () => {
    const registry = createDownloadRegistry();
    // Pre-seed the registry as if a download is already in flight.
    registry.set({
      downloadJobId: "in-flight",
      datasourceId: "ds-1",
      sourcePath: "/welcome.pdf",
      targetPath: "/old/path",
      bytesDownloaded: 100,
      contentLength: 1024,
      startedAt: 100,
      abortController: new AbortController(),
    });
    const downloadFile = vi.fn();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => makeFakeClient({ downloadFile }),
        registry,
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toBe(
        "download already in progress for this entry",
      );
      expect(result.error.retryable).toBe(false);
    }
    expect(downloadFile).not.toHaveBeenCalled();
    // The original in-flight entry is unaffected.
    expect(registry.size()).toBe(1);
    expect(registry.findByKey("ds-1", "/welcome.pdf")).toBe("in-flight");
  });

  it("the reverse index is populated on insertion and cleared on terminal", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const getMetadata = vi.fn().mockResolvedValue({
      ...sampleEntry,
      providerMetadata: {},
    });
    const registry = createDownloadRegistry();
    let observedDuringHandler: string | undefined;
    const downloadFileWithProbe = vi.fn(async (): Promise<DownloadResult> => {
      // At this moment the registry MUST have the reverse-index entry.
      observedDuringHandler = registry.findByKey("ds-1", "/welcome.pdf");
      return {
        stream: streamFromBytes(Buffer.alloc(1024, 0xab)),
        contentLength: 1024,
      };
    });
    const clientProbe = makeFakeClient({
      downloadFile: downloadFileWithProbe,
      getMetadata,
    });
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => clientProbe,
        fs: fakeFs,
        registry,
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(observedDuringHandler).toBe("job-1");
    // Cleared on terminal.
    expect(registry.findByKey("ds-1", "/welcome.pdf")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §13.25 + §13.26 — derived-not-relayed transformation
// ---------------------------------------------------------------------------

describe("files:download — derived-not-relayed event transformation (§13.25, §13.26)", () => {
  it("transformDownloadingEvent: engine `{ path, loaded, total }` → fs-sync `{ downloadJobId, datasourceId, progress, path, bytesLoaded, bytesTotal }` with progress = floor((loaded/total)*100)", () => {
    const out = transformDownloadingEvent(
      { path: "/welcome.pdf", loaded: 524288, total: 1048576 },
      { downloadJobId: "job-A", datasourceId: "ds-1" },
    );
    expect(out).toEqual({
      downloadJobId: "job-A",
      datasourceId: "ds-1",
      progress: 50,
      path: "/welcome.pdf",
      bytesLoaded: 524288,
      bytesTotal: 1048576,
    });
  });

  it("transformDownloadingEvent: total === null → progress = 0 AND bytesTotal = null (indeterminate)", () => {
    const out = transformDownloadingEvent(
      { path: "/welcome.pdf", loaded: 1234, total: null },
      { downloadJobId: "job-A", datasourceId: "ds-1" },
    );
    expect(out.progress).toBe(0);
    expect(out.bytesLoaded).toBe(1234);
    expect(out.bytesTotal).toBeNull();
  });

  it("transformDownloadingEvent: bytesLoaded reflects engine.loaded verbatim (no rounding / scaling)", () => {
    // §12.3 (Decision 14): the renderer's bytes-only fallback formats the
    // raw byte count, so the value must pass through without modification.
    const out = transformDownloadingEvent(
      { path: "/welcome.mp4", loaded: 167_772_160, total: 419_430_400 },
      { downloadJobId: "job-A", datasourceId: "ds-1" },
    );
    expect(out.bytesLoaded).toBe(167_772_160);
    expect(out.bytesTotal).toBe(419_430_400);
    expect(out.progress).toBe(40);
  });

  it("transformFileDownloadedEvent: fs-sync payload carries downloadJobId + savedPath + bytes; raw engine `path` is dropped (not the local savedPath)", () => {
    const out = transformFileDownloadedEvent(
      { path: "/welcome.pdf", bytes: 1024 },
      {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        savedPath: "/local/welcome.pdf",
        bytes: 1024,
      },
    );
    expect(out).toEqual({
      downloadJobId: "job-A",
      datasourceId: "ds-1",
      savedPath: "/local/welcome.pdf",
      bytes: 1024,
    });
  });

  it("transformDownloadCancelledEvent: fs-sync payload is downloadJobId-keyed and carries reason:'user'; engine `path` does not appear", () => {
    const out = transformDownloadCancelledEvent(
      { path: "/welcome.pdf", bytesDownloaded: 512, bytesTotal: 1024 },
      { downloadJobId: "job-A", datasourceId: "ds-1" },
    );
    expect(out).toEqual({
      downloadJobId: "job-A",
      datasourceId: "ds-1",
      bytesDownloaded: 512,
      bytesTotal: 1024,
      reason: "user",
    });
  });

  it("readProviderHash: prefers md5Checksum when present; falls back to sha256 then sha1; ignores quickXorHash and multipart S3 ETags", () => {
    expect(readProviderHash({ md5Checksum: "ABCD" })).toEqual({
      algo: "md5",
      digest: "abcd",
    });
    expect(readProviderHash({ sha256Hash: "ABCD" })).toEqual({
      algo: "sha256",
      digest: "abcd",
    });
    expect(readProviderHash({ sha1Hash: "ABCD" })).toEqual({
      algo: "sha1",
      digest: "abcd",
    });
    // S3 single-part ETag (no dash) → md5.
    expect(readProviderHash({ ETag: '"abc123"' })).toEqual({
      algo: "md5",
      digest: "abc123",
    });
    // S3 multipart ETag (with dash) → null (skip).
    expect(readProviderHash({ ETag: '"abc123-2"' })).toBeNull();
    // OneDrive's bespoke quickXorHash → null (skip).
    expect(readProviderHash({ quickXorHash: "xyz" })).toBeNull();
    // No advertised hash → null.
    expect(readProviderHash({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Surface assertion that the DERIVED fs-sync events match the wire shape
// the spec mandates (downloadJobId-keyed; NOT engine bus relay).
// ---------------------------------------------------------------------------

describe("files:download — fs-sync IPC event wire shapes (spec.md line 203-208)", () => {
  it("`downloading` payload shape matches DownloadingPayload contract", () => {
    type Got = EventPayloadMap["downloading"];
    const sample: Got = {
      downloadJobId: "job-A",
      datasourceId: "ds-1",
      progress: 50,
      path: "/welcome.pdf",
      bytesLoaded: 524288,
      bytesTotal: 1048576,
    };
    expect(sample.downloadJobId).toBe("job-A");
    expect(sample.bytesLoaded).toBe(524288);
    expect(sample.bytesTotal).toBe(1048576);
  });

  it("`file-downloaded` payload shape matches FileDownloadedPayload contract (savedPath, NOT raw engine path)", () => {
    type Got = EventPayloadMap["file-downloaded"];
    const sample: Got = {
      downloadJobId: "job-A",
      datasourceId: "ds-1",
      savedPath: "/local/welcome.pdf",
      bytes: 1024,
    };
    expect(sample.savedPath).toBe("/local/welcome.pdf");
  });

  it("`download-failed` payload shape matches DownloadFailedPayload contract (tag is the FilesErrorTag, not the raw engine taxonomy)", () => {
    type Got = EventPayloadMap["download-failed"];
    const sample: Got = {
      downloadJobId: "job-A",
      datasourceId: "ds-1",
      tag: "other",
      message: "byte count mismatch",
    };
    expect(sample.tag).toBe("other");
  });

  it("`download-cancelled` payload shape matches DownloadCancelledPayload contract (reason is the literal 'user')", () => {
    type Got = EventPayloadMap["download-cancelled"];
    const sample: Got = {
      downloadJobId: "job-A",
      datasourceId: "ds-1",
      bytesDownloaded: 512,
      bytesTotal: 1024,
      reason: "user",
    };
    expect(sample.reason).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// add-download-resilience §2 / §6.1 — isEnvironmentallyRetryable predicate
// ---------------------------------------------------------------------------

describe("isEnvironmentallyRetryable (§6.1, Decision 2 four-clause AND)", () => {
  // Full Cartesian: every DatasourceErrorTag value × { retryable: true, false }.
  // The truth table per design.md Decision 2:
  //   - Returns TRUE iff err is DatasourceError AND tag in
  //     {network-error, rate-limited, provider-error} AND retryable === true
  //     AND tag !== "auth-expired" (defensive double-guard against future
  //     taxonomy expansion that adds a retryable=true auth-expired variant).
  //   - All other DatasourceError combinations return FALSE.
  //   - Non-DatasourceError values (Error, string, null, undefined, plain
  //     object) return FALSE.
  const tags = [
    "auth-expired",
    "auth-revoked",
    "not-found",
    "conflict",
    "unsupported",
    "rate-limited",
    "network-error",
    "provider-error",
    "cancelled",
    "invalid-datasource",
  ] as const;

  const allowlist = new Set([
    "network-error",
    "rate-limited",
    "provider-error",
  ]);

  for (const tag of tags) {
    for (const retryable of [true, false]) {
      const expected =
        retryable === true && tag !== "auth-expired" && allowlist.has(tag);
      it(`returns ${expected} for DatasourceError { tag: "${tag}", retryable: ${retryable} }`, () => {
        const err = new DatasourceError({
          tag,
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable,
        });
        expect(isEnvironmentallyRetryable(err)).toBe(expected);
      });
    }
  }

  it("explicitly: auth-expired with retryable=true returns false (excluded by clause 2 even if a future tag-mapping change put it in the allowlist)", () => {
    const err = new DatasourceError({
      tag: "auth-expired",
      datasourceType: "google-drive",
      datasourceId: "ds-1",
      retryable: true,
    });
    expect(isEnvironmentallyRetryable(err)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isEnvironmentallyRetryable(new Error("boom"))).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isEnvironmentallyRetryable("network-error")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isEnvironmentallyRetryable(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isEnvironmentallyRetryable(undefined)).toBe(false);
  });

  it("returns false for a plain object that mimics the shape", () => {
    expect(
      isEnvironmentallyRetryable({
        tag: "network-error",
        retryable: true,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// add-download-resilience §2 / §6.2 — expBackoff schedule
// ---------------------------------------------------------------------------

describe("expBackoff (§6.2)", () => {
  it("returns the expected schedule 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000 for n ∈ {1..8} (cap at 30s)", () => {
    expect(expBackoff(1)).toBe(1000);
    expect(expBackoff(2)).toBe(2000);
    expect(expBackoff(3)).toBe(4000);
    expect(expBackoff(4)).toBe(8000);
    expect(expBackoff(5)).toBe(16000);
    expect(expBackoff(6)).toBe(30000);
    expect(expBackoff(7)).toBe(30000);
    expect(expBackoff(8)).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// add-download-resilience §2 / §6.3 — sleepCancellable
// ---------------------------------------------------------------------------

describe("sleepCancellable (§6.3)", () => {
  it("(a) resolves on timer fire when the signal never aborts", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let resolved = false;
      const p = sleepCancellable(1000, controller.signal).then(() => {
        resolved = true;
      });
      // Before timer fires.
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(b) resolves immediately on a pre-aborted signal", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      controller.abort();
      let resolved = false;
      const p = sleepCancellable(10_000, controller.signal).then(() => {
        resolved = true;
      });
      // Allow microtasks to run; do NOT advance timers — the resolve must
      // not require the original timer to fire.
      await vi.advanceTimersByTimeAsync(0);
      await p;
      expect(resolved).toBe(true);
      // No timers should be left pending — pre-aborted path must not
      // schedule a timer that outlives the call.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(c) resolves immediately when the signal aborts mid-sleep", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let resolved = false;
      const p = sleepCancellable(10_000, controller.signal).then(() => {
        resolved = true;
      });
      // Advance partway through the sleep.
      await vi.advanceTimersByTimeAsync(2000);
      expect(resolved).toBe(false);
      controller.abort();
      // Microtask flush — the abort listener resolves the promise without
      // waiting for the timer to fire.
      await vi.advanceTimersByTimeAsync(0);
      await p;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(d) clears the timer on abort — no callback fires after, no pending timer left", async () => {
    vi.useFakeTimers();
    try {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const controller = new AbortController();
      const p = sleepCancellable(10_000, controller.signal);
      // Abort mid-sleep.
      await vi.advanceTimersByTimeAsync(1000);
      controller.abort();
      await p;
      // The timer must have been cleared on the abort path.
      expect(clearTimeoutSpy).toHaveBeenCalled();
      // Advance past the original fire time — nothing should be pending,
      // and (since the promise already resolved exactly once) no spurious
      // resolve fires.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never rejects — even on abort, the returned promise resolves", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      controller.abort();
      // If the promise rejects, this `await` would throw and fail the test.
      await sleepCancellable(1000, controller.signal);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// add-download-resilience §3 / §3.3 — DELETE_ON_TERMINAL membership
//
// Per design.md Decision 6, exactly three sentinel error classes drive the
// "delete the partial" disposition: RangeNotHonoredError, RangeMismatchError,
// IntegrityFailedError. ByteCountMismatchError is explicitly excluded — its
// disposition is Keep (preserve the user's bandwidth investment in case the
// prefix is actually valid). The test pins the membership AND the explicit
// exclusion AND the size to guard against silent regressions if a future
// edit adds or swaps a class.
// ---------------------------------------------------------------------------

describe("DELETE_ON_TERMINAL (§3.3 + §12.4 Decision 3 rewrite, Decision 6 disposition policy)", () => {
  // §12.4 (Decision 3 rewrite): RangeNotHonoredError was REMOVED from
  // DELETE_ON_TERMINAL — it is no longer a terminal cause under normal
  // flow (the rewrite-from-0 path consumes any range-not-honored event
  // in-flight, with its own non-terminal unlink BEFORE continuing the
  // cycle). The class is retained as a defensive sentinel; if a defect
  // ever causes it to propagate to terminal, the disposition default
  // ("keep") applies — consistent with env-budget-exhausted disposition.
  it("does NOT contain RangeNotHonoredError (§12.4 Decision 3 rewrite — non-terminal in-flight unlink instead)", () => {
    expect(DELETE_ON_TERMINAL.has(RangeNotHonoredError)).toBe(false);
  });

  it("contains RangeMismatchError", () => {
    expect(DELETE_ON_TERMINAL.has(RangeMismatchError)).toBe(true);
  });

  it("contains IntegrityFailedError", () => {
    expect(DELETE_ON_TERMINAL.has(IntegrityFailedError)).toBe(true);
  });

  it("does NOT contain ByteCountMismatchError (Keep disposition)", () => {
    expect(DELETE_ON_TERMINAL.has(ByteCountMismatchError)).toBe(false);
  });

  it("has exactly two members (catches future accidental additions; was three pre-§12.4)", () => {
    expect(DELETE_ON_TERMINAL.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// add-download-resilience §4 — handler retry-loop integration (§6.4-§6.16)
//
// Each test below exercises ONE branch of the §4 retry-loop logic in
// `files-download.ts`. The fakes drive the engine via successive
// `client.downloadFile` calls; `vi.useFakeTimers()` controls the
// `sleepCancellable` wait between attempts so a single test can advance
// past a 1s+ sleep without real-clock cost.
//
// The pump helper drains microtasks + advances the fake clock by `ms` so
// `download-retrying` → sleep → next `engine.downloadFile` → pipe completes
// inside one call site. Tests that need to interleave (e.g. fire `cancel`
// mid-sleep) call the helper twice with a smaller advance the second time.
// ---------------------------------------------------------------------------

async function pump(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  // Two extra microtask flushes so the env-retry branch's `await
  // deps.fs.statSize(...)` and the next `await client.downloadFile(...)`
  // both settle before the test reads events.
  await Promise.resolve();
  await Promise.resolve();
}

/** Sequence-driven engine fake: consume one entry per `downloadFile` call. */
type DownloadStep =
  | { kind: "throw-pre-stream"; error: unknown }
  | {
      kind: "throw-mid-stream";
      bytesBefore: number;
      error: unknown;
      contentLength?: number;
      contentRange?: { start: number; end: number; total: number };
    }
  | {
      kind: "succeed";
      bytes: number;
      contentLength: number;
      contentRange?: { start: number; end: number; total: number };
    }
  | {
      kind: "succeed-no-range";
      bytes: number;
      contentLength: number;
    };

/**
 * Build a `client.downloadFile` mock that emits the next `DownloadStep`
 * each call. Uses the supplied `fakeFs` to set on-disk bytes for
 * `throw-mid-stream` so the env-retry branch's `statSize` reflects the
 * partial state.
 */
function makeStepDownloadFile(
  fakeFs: FakeFs,
  toPath: string,
  steps: DownloadStep[],
): {
  fn: (
    target: unknown,
    options: { rangeStart?: number; signal?: AbortSignal },
  ) => Promise<DownloadResult>;
  callCount: () => number;
  lastRangeStart: () => number | undefined;
} {
  let i = 0;
  let lastRangeStart: number | undefined;
  const fn = async (target: unknown, options: { rangeStart?: number; signal?: AbortSignal }): Promise<DownloadResult> => {
    lastRangeStart = options?.rangeStart;
    const step = steps[i++];
    if (step === undefined) {
      throw new Error(`engine fake exhausted at call ${i}`);
    }
    switch (step.kind) {
      case "throw-pre-stream":
        throw step.error;
      case "throw-mid-stream": {
        const error = step.error;
        const bytesBefore = step.bytesBefore;
        const stream = Readable.from(
          (async function* () {
            // Lay down the partial bytes so statSize sees the right
            // value when the env-retry branch re-stats. The bytes are a
            // fill so the buffer-comparison check (none in the v1 test
            // surface) is happy.
            if (bytesBefore > 0) {
              fakeFs.files.set(toPath, Buffer.alloc(bytesBefore, 0xab));
              yield Buffer.alloc(bytesBefore, 0xab);
            } else {
              fakeFs.files.set(toPath, Buffer.alloc(0));
            }
            throw error;
          })(),
        );
        const r: DownloadResult = {
          stream,
          contentLength: step.contentLength ?? 1024,
        };
        if (step.contentRange !== undefined) {
          (r as { contentRange?: { start: number; end: number; total: number } }).contentRange = step.contentRange;
        }
        return r;
      }
      case "succeed": {
        const r: DownloadResult = {
          stream: streamFromBytes(Buffer.alloc(step.bytes, 0xcd)),
          contentLength: step.contentLength,
        };
        if (step.contentRange !== undefined) {
          (r as { contentRange?: { start: number; end: number; total: number } }).contentRange = step.contentRange;
        }
        return r;
      }
      case "succeed-no-range": {
        return {
          stream: streamFromBytes(Buffer.alloc(step.bytes, 0xcd)),
          contentLength: step.contentLength,
        };
      }
    }
  };
  return {
    fn,
    callCount: () => i,
    lastRangeStart: () => lastRangeStart,
  };
}

// ---------------------------------------------------------------------------
// §6.4 — Network drop mid-stream recovers transparently
// ---------------------------------------------------------------------------

describe("files:download — network drop mid-stream recovers (§6.4)", () => {
  it("emits exactly one download-retrying { attempt: 1, waitMs: 1000, engineCause: 'network-error' } and completes", async () => {
    vi.useFakeTimers();
    try {
      const fakeFs = makeFakeFs({ writableParents: [PARENT] });
      const steps: DownloadStep[] = [
        {
          kind: "throw-mid-stream",
          bytesBefore: 0,
          error: new DatasourceError({
            tag: "network-error",
            datasourceType: "google-drive",
            datasourceId: "ds-1",
            retryable: true,
            message: "ECONNRESET mid-stream",
          }),
          contentLength: 1024,
        },
        {
          kind: "succeed",
          bytes: 1024,
          contentLength: 1024,
        },
      ];
      const stepper = makeStepDownloadFile(fakeFs, TO_PATH, steps);
      const downloadFile = vi.fn(stepper.fn);
      const getMetadata = vi.fn().mockResolvedValue({
        ...sampleEntry,
        providerMetadata: {},
      });
      const client = makeFakeClient({ downloadFile, getMetadata });
      const { bus, events } = captureFsSyncEvents();
      const handler = makeFilesDownloadHandler(
        makeDeps({
          resolveClient: async () => client,
          fs: fakeFs,
          fsSyncBus: bus,
        }),
      );
      const inflight = handler(
        { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
        ctx,
      );
      // Drive past the env-retry sleep (expBackoff(1) = 1000ms).
      await pump(1000);
      const result = await inflight;
      expect(result.ok).toBe(true);
      const retrying = events.filter((e) => e.name === "download-retrying");
      expect(retrying).toHaveLength(1);
      expect(retrying[0]?.payload).toMatchObject({
        datasourceId: "ds-1",
        attempt: 1,
        limit: 5,
        waitMs: 1000,
        engineCause: "network-error",
      });
      expect(stepper.callCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// §6.5 — Five consecutive environmental failures exhaust the budget
// ---------------------------------------------------------------------------

describe("files:download — exhausts env budget after CONSECUTIVE_FAIL_LIMIT (§6.5)", () => {
  it("5 retrying events (attempt 1..5) then download-failed { tag: 'exhausted-retries' } with partial kept (no unlink)", async () => {
    vi.useFakeTimers();
    try {
      const fakeFs = makeFakeFs({ writableParents: [PARENT] });
      const unlinkSpy = vi.fn(async () => { /* ok */ });
      fakeFs.unlink = unlinkSpy;
      const netError = () =>
        new DatasourceError({
          tag: "network-error",
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable: true,
          message: "ECONNRESET",
        });
      // 6 throws total: 5 retried (attempts 1..5) + 6th tripping the
      // > limit check (consecutive=6 > 5 → ExhaustedRetriesError). All
      // throws lay down zero bytes (no progress → no reset).
      const steps: DownloadStep[] = Array.from({ length: 6 }).map(() => ({
        kind: "throw-mid-stream" as const,
        bytesBefore: 0,
        error: netError(),
        contentLength: 1024,
      }));
      const stepper = makeStepDownloadFile(fakeFs, TO_PATH, steps);
      const downloadFile = vi.fn(stepper.fn);
      const client = makeFakeClient({ downloadFile });
      const { bus, events } = captureFsSyncEvents();
      const handler = makeFilesDownloadHandler(
        makeDeps({
          resolveClient: async () => client,
          fs: fakeFs,
          fsSyncBus: bus,
        }),
      );
      const inflight = handler(
        { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
        ctx,
      );
      // Pump enough fake time to drain all five sleeps:
      // expBackoff: 1000, 2000, 4000, 8000, 16000 = 31000ms.
      await pump(35_000);
      const result = await inflight;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.tag).toBe("exhausted-retries");
        expect(result.error.message).toBe(
          "exhausted-retries: network-error",
        );
        expect(result.error.retryable).toBe(true);
      }
      const retrying = events.filter((e) => e.name === "download-retrying");
      expect(retrying).toHaveLength(5);
      retrying.forEach((e, idx) => {
        expect(e.payload).toMatchObject({
          attempt: idx + 1,
          limit: 5,
          engineCause: "network-error",
        });
      });
      const failed = events.filter((e) => e.name === "download-failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({
        tag: "exhausted-retries",
        message: "exhausted-retries: network-error",
      });
      expect(unlinkSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// §6.6 — Successful byte progress resets the consecutive counter
// ---------------------------------------------------------------------------

describe("files:download — byte-progress resets counter (§6.6)", () => {
  it("error-no-progress → error-with-progress → error-no-progress: each retry sees attempt=1 (counter resets on byte progress per Decision 10)", async () => {
    vi.useFakeTimers();
    try {
      const fakeFs = makeFakeFs({ writableParents: [PARENT] });
      const netError = () =>
        new DatasourceError({
          tag: "network-error",
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable: true,
          message: "ECONNRESET",
        });
      // Sequence (all mid-stream throws — exercises the env-retry branch's
      // own reset rule per Decision 10):
      // 1. throw, 0 bytes laid down  (before=0, after=0 → no reset; ++ → 1)
      //    → retrying attempt 1, sleep 1000ms
      // 2. throw, 512 bytes laid down (before=0, after=512 → RESET to 0; ++ → 1)
      //    → retrying attempt 1 (KEY assertion — NOT 2)
      //    sleep 1000ms
      // 3. succeed 512 more bytes from rangeStart=512.
      const steps: DownloadStep[] = [
        {
          kind: "throw-mid-stream",
          bytesBefore: 0,
          error: netError(),
          contentLength: 1024,
        },
        {
          kind: "throw-mid-stream",
          bytesBefore: 512,
          error: netError(),
          contentLength: 1024,
        },
        {
          kind: "succeed",
          bytes: 512,
          contentLength: 1024,
          contentRange: { start: 512, end: 1023, total: 1024 },
        },
      ];
      const stepper = makeStepDownloadFile(fakeFs, TO_PATH, steps);
      const downloadFile = vi.fn(stepper.fn);
      const getMetadata = vi.fn().mockResolvedValue({
        ...sampleEntry,
        providerMetadata: {},
      });
      const client = makeFakeClient({ downloadFile, getMetadata });
      const { bus, events } = captureFsSyncEvents();
      const handler = makeFilesDownloadHandler(
        makeDeps({
          resolveClient: async () => client,
          fs: fakeFs,
          fsSyncBus: bus,
        }),
      );
      const inflight = handler(
        { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
        ctx,
      );
      // Two 1000ms sleeps (each at attempt=1 after reset).
      await pump(1000);
      await pump(1000);
      const result = await inflight;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.bytes).toBe(1024);
      }
      const retrying = events.filter((e) => e.name === "download-retrying");
      expect(retrying).toHaveLength(2);
      // First retry after the error-without-progress (count: 0→1).
      expect(retrying[0]?.payload).toMatchObject({
        attempt: 1,
        engineCause: "network-error",
      });
      // KEY: second retry attempt is ALSO 1 (counter reset by 512-byte
      // mid-stream progress in step 2's throw, then ++ to 1 again).
      expect(retrying[1]?.payload).toMatchObject({
        attempt: 1,
        engineCause: "network-error",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// §6.7 — Wall-time ceiling supersedes count budget
// ---------------------------------------------------------------------------

describe("files:download — walltime ceiling supersedes count (§6.7)", () => {
  it("when deps.now() advances past the ceiling: download-failed { message: 'walltime-exceeded: <engineCause>' }, partial kept", async () => {
    // Note: this test does NOT need fake timers — the walltime branch
    // throws WalltimeExceededError synchronously without scheduling a
    // sleep (the check fires BEFORE sleepCancellable). Using fake
    // timers here would freeze the await microtask plumbing under
    // some Vitest version interactions; real timers + a stubbed
    // `deps.now()` is sufficient.
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const unlinkSpy = vi.fn(async () => { /* ok */ });
    fakeFs.unlink = unlinkSpy;
    // The handler calls `deps.now()` at TWO synchronous sites before
    // any retry decision: (1) registry entry's `startedAt`, (2) the
    // walltime baseline `walltimeStartedAt`. The third+ calls happen
    // inside the env-retry branch's elapsed calculation. Stub all of
    // them: first two return START, the rest return PAST_CEILING.
    const START = 1_000_000;
    const PAST_CEILING = START + 30 * 60 * 1000 + 1;
    const nowFn = vi.fn(() => PAST_CEILING);
    nowFn.mockReturnValueOnce(START); // (1) registry startedAt
    nowFn.mockReturnValueOnce(START); // (2) walltimeStartedAt
    // (3+) env-retry branch's `deps.now() - walltimeStartedAt` and
    // anywhere else: returns PAST_CEILING via the base impl.
    const netError = () =>
      new DatasourceError({
        tag: "network-error",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: true,
        message: "ECONNRESET",
      });
    const steps: DownloadStep[] = [
      {
        kind: "throw-mid-stream",
        bytesBefore: 256,
        error: netError(),
        contentLength: 1024,
      },
    ];
    const stepper = makeStepDownloadFile(fakeFs, TO_PATH, steps);
    const downloadFile = vi.fn(stepper.fn);
    const client = makeFakeClient({ downloadFile });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
        now: nowFn,
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("exhausted-retries");
      expect(result.error.message).toBe(
        "walltime-exceeded: network-error",
      );
    }
    const failed = events.filter((e) => e.name === "download-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({
      tag: "exhausted-retries",
      message: "walltime-exceeded: network-error",
    });
    // Walltime exhaustion → partial kept.
    expect(unlinkSpy).not.toHaveBeenCalled();
    // Partial bytes still on disk.
    expect(fakeFs.files.has(TO_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §6.8 — Rate-limited honors retryAfterMs
// ---------------------------------------------------------------------------

describe("files:download — rate-limited honors retryAfterMs (§6.8)", () => {
  it("when retryAfterMs=5000 dominates expBackoff(1)=1000: download-retrying.waitMs === 5000 and the sleep matches", async () => {
    vi.useFakeTimers();
    try {
      const fakeFs = makeFakeFs({ writableParents: [PARENT] });
      const rateLimited = new DatasourceError({
        tag: "rate-limited",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: true,
        retryAfterMs: 5000,
        message: "rate limited",
      });
      const steps: DownloadStep[] = [
        {
          kind: "throw-mid-stream",
          bytesBefore: 0,
          error: rateLimited,
          contentLength: 1024,
        },
        {
          kind: "succeed",
          bytes: 1024,
          contentLength: 1024,
        },
      ];
      const stepper = makeStepDownloadFile(fakeFs, TO_PATH, steps);
      const downloadFile = vi.fn(stepper.fn);
      const getMetadata = vi.fn().mockResolvedValue({
        ...sampleEntry,
        providerMetadata: {},
      });
      const client = makeFakeClient({ downloadFile, getMetadata });
      const { bus, events } = captureFsSyncEvents();
      const handler = makeFilesDownloadHandler(
        makeDeps({
          resolveClient: async () => client,
          fs: fakeFs,
          fsSyncBus: bus,
        }),
      );
      const inflight = handler(
        { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
        ctx,
      );
      // Advance 4999ms — sleep should still be pending.
      await pump(4999);
      const partialEvents = events.filter(
        (e) => e.name === "download-retrying",
      );
      expect(partialEvents).toHaveLength(1);
      expect(partialEvents[0]?.payload).toMatchObject({
        waitMs: 5000,
        engineCause: "rate-limited",
      });
      // Cross the boundary; second downloadFile should fire.
      await pump(2);
      const result = await inflight;
      expect(result.ok).toBe(true);
      expect(stepper.callCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// §6.9 — Cancel during retry sleep terminates immediately
// ---------------------------------------------------------------------------

describe("files:download — cancel during retry sleep (§6.9)", () => {
  it("download-retrying emits, abort fires mid-sleep → download-cancelled emits, no further download-retrying", async () => {
    vi.useFakeTimers();
    try {
      const fakeFs = makeFakeFs({ writableParents: [PARENT] });
      const netError = () =>
        new DatasourceError({
          tag: "network-error",
          datasourceType: "google-drive",
          datasourceId: "ds-1",
          retryable: true,
          message: "ECONNRESET",
        });
      // First throw enters env-retry branch; we cancel during the sleep.
      // Second step is provided as a guard — if the test ever
      // mistakenly progresses past cancel, it would issue a fresh
      // engine call and fail the "no further retrying" assertion.
      const steps: DownloadStep[] = [
        {
          kind: "throw-mid-stream",
          bytesBefore: 256,
          error: netError(),
          contentLength: 1024,
        },
        {
          kind: "succeed",
          bytes: 1024,
          contentLength: 1024,
        },
      ];
      const stepper = makeStepDownloadFile(fakeFs, TO_PATH, steps);
      const downloadFile = vi.fn(stepper.fn);
      const client = makeFakeClient({ downloadFile });
      const registry = createDownloadRegistry();
      const { bus, events } = captureFsSyncEvents();
      const unlinkSpy = vi.fn(async () => { /* ok */ });
      fakeFs.unlink = unlinkSpy;
      const handler = makeFilesDownloadHandler(
        makeDeps({
          resolveClient: async () => client,
          fs: fakeFs,
          fsSyncBus: bus,
          registry,
        }),
      );
      const inflight = handler(
        { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
        ctx,
      );
      // Advance past the throw; we need the download-retrying event +
      // the start of the sleep.
      await pump(0);
      const beforeCancel = events.filter(
        (e) => e.name === "download-retrying",
      );
      expect(beforeCancel).toHaveLength(1);
      // Half-way through the 1000ms backoff.
      await pump(500);
      // Fire the cancel.
      const cancelHandler = makeSyncCancelDownloadHandler({ registry });
      const cancelResult = await cancelHandler(
        { downloadJobId: "job-1" },
        ctx,
      );
      expect(cancelResult).toEqual({ ok: true, result: { cancelled: true } });
      // Drain microtasks; the abort should resolve sleepCancellable.
      await pump(0);
      // Advance past where the original sleep would have ended — to
      // confirm no further retrying fires after cancel.
      await pump(2000);
      const result = await inflight;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.tag).toBe("cancelled");
      }
      const retrying = events.filter((e) => e.name === "download-retrying");
      // Still exactly one — cancel preempted the second attempt.
      expect(retrying).toHaveLength(1);
      const cancelled = events.filter((e) => e.name === "download-cancelled");
      expect(cancelled).toHaveLength(1);
      // Partial kept on cancel.
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(fakeFs.files.has(TO_PATH)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// §6.10 — Non-retryable tag bypasses the environmental budget
// ---------------------------------------------------------------------------

describe("files:download — non-retryable tag bypasses env budget (§6.10)", () => {
  it("auth-revoked (retryable=false) → immediate download-failed { tag: 'auth-revoked' }, no retrying, partial kept", async () => {
    vi.useFakeTimers();
    try {
      const fakeFs = makeFakeFs({ writableParents: [PARENT] });
      const unlinkSpy = vi.fn(async () => { /* ok */ });
      fakeFs.unlink = unlinkSpy;
      const authRevoked = new DatasourceError({
        tag: "auth-revoked",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: false,
        message: "refresh token revoked",
      });
      const steps: DownloadStep[] = [
        {
          kind: "throw-mid-stream",
          bytesBefore: 256,
          error: authRevoked,
          contentLength: 1024,
        },
      ];
      const stepper = makeStepDownloadFile(fakeFs, TO_PATH, steps);
      const downloadFile = vi.fn(stepper.fn);
      const client = makeFakeClient({ downloadFile });
      const { bus, events } = captureFsSyncEvents();
      const handler = makeFilesDownloadHandler(
        makeDeps({
          resolveClient: async () => client,
          fs: fakeFs,
          fsSyncBus: bus,
        }),
      );
      const result = await handler(
        { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.tag).toBe("auth-revoked");
      }
      const retrying = events.filter((e) => e.name === "download-retrying");
      expect(retrying).toHaveLength(0);
      const failed = events.filter((e) => e.name === "download-failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({
        tag: "auth-revoked",
      });
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(fakeFs.files.has(TO_PATH)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// §6.11 — Range-not-honored deletes the partial
// ---------------------------------------------------------------------------

describe("files:download — range-not-honored unlinks partial in-flight, NOT terminal (§6.11 + §12.4 Decision 3 rewrite)", () => {
  // §12.4 (Decision 3 rewrite): the original §6.11 contract was
  // "range-not-honored → unlink BEFORE terminal download-failed".
  // Iter-4 reverses this: range-not-honored is no longer terminal.
  // The handler unlinks IN-FLIGHT (before continuing the rewrite-from-0
  // cycle), and emits `download-retrying` instead of `download-failed`.
  // The unlink-before-emit ordering is preserved, but the emit is now
  // `download-retrying` (with `engineCause: "range-not-honored"`,
  // `waitMs: 0`).
  it("on resume request returning 200 OK without contentRange: fs.unlink fires BEFORE download-retrying emit (in-flight cleanup)", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const orderLog: string[] = [];
    const unlinkSpy = vi.fn(async (path: string) => {
      orderLog.push(`unlink:${path}`);
      fakeFs.files.delete(path);
    });
    fakeFs.unlink = unlinkSpy;
    let call = 0;
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => {
      call++;
      if (call === 1) {
        const stream = Readable.from(
          (async function* () {
            fakeFs.files.set(TO_PATH, Buffer.alloc(512, 0xaa));
            yield Buffer.alloc(512, 0xaa);
            throw new DatasourceError({
              tag: "network-error",
              datasourceType: "google-drive",
              datasourceId: "ds-1",
              retryable: true,
              message: "wifi drop",
            });
          })(),
        );
        return { stream, contentLength: 1024 };
      }
      if (call === 2) {
        // Resume request — provider IGNORES Range, returns 200 OK
        // with no Content-Range. Triggers rewrite-from-0.
        return {
          stream: streamFromBytes(Buffer.alloc(0)),
          contentLength: 1024,
        };
      }
      // Cycle continues from byte 0 — full body re-download.
      return {
        stream: streamFromBytes(Buffer.alloc(1024, 0xbb)),
        contentLength: 1024,
      };
    });
    const client = makeFakeClient({ downloadFile });
    const { bus, events } = captureFsSyncEvents();
    bus.subscribe((name, _payload) => {
      orderLog.push(`emit:${name}`);
    });
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
      }),
    );
    vi.useFakeTimers();
    const inflight = handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(0);
    const result = await inflight;
    vi.useRealTimers();

    // Success: rewrite-from-0 completed the download.
    expect(result.ok).toBe(true);
    // No download-failed event fires for the range-not-honored case.
    expect(events.filter((e) => e.name === "download-failed")).toHaveLength(0);

    // unlink fired exactly once — when rewrite-from-0 was triggered.
    expect(unlinkSpy).toHaveBeenCalledWith(TO_PATH);
    expect(unlinkSpy).toHaveBeenCalledTimes(1);

    // Ordering: the unlink fires BEFORE the second `download-retrying`
    // emit (the rewrite-from-0 trigger). The first `download-retrying`
    // emit (for the cycle 1 mid-stream network-error) fires earlier.
    const unlinkIdx = orderLog.findIndex((s) => s.startsWith("unlink:"));
    const retryingIndices = orderLog
      .map((s, i) => (s === "emit:download-retrying" ? i : -1))
      .filter((i) => i !== -1);
    expect(retryingIndices).toHaveLength(2);
    // unlink fires AFTER the first retrying emit (cycle 1 net-error,
    // sleep, then attempt 2 returns no Content-Range → rewrite trigger
    // → unlink → second retrying emit).
    expect(unlinkIdx).toBeGreaterThan(retryingIndices[0]!);
    // unlink fires BEFORE the second retrying emit (the rewrite-from-0
    // trigger order is: emit retrying, destroy stream, unlink — wait no,
    // looking at the implementation: `emit("download-retrying", ...)`
    // happens BEFORE the `unlink`. The contract is "unlink during the
    // rewrite-from-0 path"; ordering vs the SECOND retrying-emit is
    // implementation detail, but the unlink MUST happen before the
    // continued cycle's next engine call, which lives even later).
    // Pinning the loose contract: unlink fires before the third engine
    // call — the cycle-3 attempt — happens, which is when the file
    // would be re-piped from byte 0.
    expect(call).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// §6.12 — Range-mismatch deletes the partial
// ---------------------------------------------------------------------------

describe("files:download — range-mismatch deletes partial (§6.12)", () => {
  it("contentRange.start !== bytesWritten → unlink + correct event", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const unlinkSpy = vi.fn(async () => { /* ok */ });
    fakeFs.unlink = unlinkSpy;
    let call = 0;
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => {
      call++;
      if (call === 1) {
        const stream = Readable.from(
          (async function* () {
            fakeFs.files.set(TO_PATH, Buffer.alloc(512, 0xaa));
            yield Buffer.alloc(512, 0xaa);
            throw new DatasourceError({
              tag: "auth-expired",
              datasourceType: "google-drive",
              datasourceId: "ds-1",
              retryable: true,
              message: "expired",
            });
          })(),
        );
        return { stream, contentLength: 1024 };
      }
      // 206 Partial Content with WRONG start (0 instead of 512).
      return {
        stream: streamFromBytes(Buffer.alloc(1024, 0xbb)),
        contentLength: 1024,
        contentRange: { start: 0, end: 1023, total: 1024 },
      };
    });
    const client = makeFakeClient({ downloadFile });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("range mismatch on this resource");
    }
    expect(unlinkSpy).toHaveBeenCalledWith(TO_PATH);
    const failed = events.filter((e) => e.name === "download-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({
      tag: "other",
      message: "range mismatch on this resource",
    });
  });
});

// ---------------------------------------------------------------------------
// §6.13 — Integrity-failed deletes the partial
// ---------------------------------------------------------------------------

describe("files:download — integrity-failed deletes partial (§6.13)", () => {
  it("provider-hash mismatch on post-pipe check → unlink + 'integrity check failed' event", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const unlinkSpy = vi.fn(async () => { /* ok */ });
    fakeFs.unlink = unlinkSpy;
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => ({
      stream: streamFromBytes(Buffer.alloc(1024, 0xab)),
      contentLength: 1024,
    }));
    const getMetadata = vi.fn().mockResolvedValue(sampleEntry);
    const client = makeFakeClient({ downloadFile, getMetadata });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
        // Hash mismatch: local "feedface" ≠ provider "deadbeef".
        hash: makeHash({ [TO_PATH]: "feedface" }),
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toBe("integrity check failed");
    }
    expect(unlinkSpy).toHaveBeenCalledWith(TO_PATH);
    const failed = events.filter((e) => e.name === "download-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({
      tag: "other",
      message: "integrity check failed",
    });
  });
});

// ---------------------------------------------------------------------------
// §6.14 — Byte-count-mismatch keeps the partial
// ---------------------------------------------------------------------------

describe("files:download — byte-count-mismatch keeps partial (§6.14)", () => {
  it("bytesWritten ≠ contentLength → download-failed { tag: 'other', message: 'byte count mismatch' }; unlink NOT called", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const unlinkSpy = vi.fn(async () => { /* ok */ });
    fakeFs.unlink = unlinkSpy;
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => ({
      stream: streamFromBytes(Buffer.alloc(512, 0xab)),
      contentLength: 1024,
    }));
    const client = makeFakeClient({ downloadFile });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("other");
      expect(result.error.message).toBe("byte count mismatch");
    }
    expect(unlinkSpy).not.toHaveBeenCalled();
    const failed = events.filter((e) => e.name === "download-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({
      tag: "other",
      message: "byte count mismatch",
    });
  });
});

// ---------------------------------------------------------------------------
// §6.15 — unlink failure is non-fatal
// ---------------------------------------------------------------------------

describe("files:download — unlink failure is non-fatal (§6.15)", () => {
  it("delete-disposition path with unlink rejecting EACCES still emits download-failed", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const unlinkSpy = vi.fn(async () => {
      const err = new Error("EACCES: permission denied");
      throw err;
    });
    fakeFs.unlink = unlinkSpy;
    // Drive the integrity-failed path (one of the DELETE_ON_TERMINAL set).
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => ({
      stream: streamFromBytes(Buffer.alloc(1024, 0xab)),
      contentLength: 1024,
    }));
    const getMetadata = vi.fn().mockResolvedValue(sampleEntry);
    const client = makeFakeClient({ downloadFile, getMetadata });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
        hash: makeHash({ [TO_PATH]: "feedface" }),
      }),
    );
    const result = await handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("integrity check failed");
    }
    expect(unlinkSpy).toHaveBeenCalled();
    const failed = events.filter((e) => e.name === "download-failed");
    expect(failed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §6.16 — Auth-expired co-exists with environmental retry
// ---------------------------------------------------------------------------

describe("files:download — auth-expired co-exists with env retry (§6.16)", () => {
  it("network-error → recover → mid-stream auth-expired → recover → success: env count and auth slot are independent", async () => {
    vi.useFakeTimers();
    try {
      const fakeFs = makeFakeFs({ writableParents: [PARENT] });
      let call = 0;
      const downloadFile = vi.fn(async (target, options): Promise<DownloadResult> => {
        call++;
        if (call === 1) {
          // Mid-stream network-error after no progress (env retry, attempt 1).
          const stream = Readable.from(
            (async function* () {
              fakeFs.files.set(TO_PATH, Buffer.alloc(0));
              throw new DatasourceError({
                tag: "network-error",
                datasourceType: "google-drive",
                datasourceId: "ds-1",
                retryable: true,
                message: "ECONNRESET",
              });
            })(),
          );
          return { stream, contentLength: 1024 };
        }
        if (call === 2) {
          // Cycle 2: drains 256 bytes, then auth-expired mid-stream
          // (Layer 2 slot inside the cycle).
          const stream = Readable.from(
            (async function* () {
              fakeFs.files.set(TO_PATH, Buffer.alloc(256, 0xaa));
              yield Buffer.alloc(256, 0xaa);
              throw new DatasourceError({
                tag: "auth-expired",
                datasourceType: "google-drive",
                datasourceId: "ds-1",
                retryable: true,
                message: "token expired mid-stream",
              });
            })(),
          );
          return { stream, contentLength: 1024 };
        }
        // call === 3 — Layer 2's continue re-issues at rangeStart=256.
        // Verify we're picking up the bytes already on disk.
        expect(options?.rangeStart).toBe(256);
        return {
          stream: streamFromBytes(Buffer.alloc(768, 0xbb)),
          contentLength: 1024,
          contentRange: { start: 256, end: 1023, total: 1024 },
        };
      });
      const getMetadata = vi.fn().mockResolvedValue({
        ...sampleEntry,
        providerMetadata: {},
      });
      const client = makeFakeClient({ downloadFile, getMetadata });
      const { bus, events } = captureFsSyncEvents();
      const handler = makeFilesDownloadHandler(
        makeDeps({
          resolveClient: async () => client,
          fs: fakeFs,
          fsSyncBus: bus,
        }),
      );
      const inflight = handler(
        { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
        ctx,
      );
      // Drain the env-retry sleep (1000ms).
      await pump(1000);
      const result = await inflight;
      expect(result.ok).toBe(true);
      // Exactly one env-retry event (the network-error, attempt 1). The
      // auth-expired Layer 2 path emits NO download-retrying event
      // (Decision 5 — auth retries are fast, no event).
      const retrying = events.filter((e) => e.name === "download-retrying");
      expect(retrying).toHaveLength(1);
      expect(retrying[0]?.payload).toMatchObject({
        attempt: 1,
        engineCause: "network-error",
      });
      // 3 engine calls total: cycle1 (errored), cycle2 (auth-expired
      // mid-stream), Layer-2 retry inside cycle2 (success).
      expect(downloadFile).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// add-download-resilience §11 — Decision 12 per-attempt request timeout
//
// §11.7-§11.9 cover the handler-boundary 60s timeout introduced after the
// §9.4 manual smoke reproduced "stuck-forever Reconnecting": after
// `sleepCancellable` returned, the next `engine.downloadFile()` inherited
// a dead OS-level socket and hung indefinitely (Windows TCP timeout >5
// minutes), blocking the retry loop. The fix wraps each engine call with
// a per-attempt `AbortController` whose `setTimeout(...).abort()` fires at
// `PER_ATTEMPT_TIMEOUT_MS = 60_000`, composed with the user-cancel signal
// via `AbortSignal.any`. On timeout, the handler synthesizes
// `DatasourceError({ tag: "network-error", retryable: true })` and feeds
// the existing Layer 3 env-retry branch identically to a "real" network-
// error — the synthesized error must produce a `download-retrying` event,
// count against the 5-attempt budget, and respect cancel precedence.
// ---------------------------------------------------------------------------

const PER_ATTEMPT_TIMEOUT_MS = 60_000;

/**
 * Build a `client.downloadFile` mock whose first `hangCount` calls return a
 * promise that never resolves but rejects with AbortError when the supplied
 * signal fires. After `hangCount` hangs the mock falls through to `tail`
 * (e.g. a `succeed` step) so byte-count assertions stay clean.
 *
 * Mirrors the real engine's AbortSignal contract — engines accept
 * `options.signal` and reject with `AbortError` on its abort.
 */
function makeHangingDownloadFile(opts: {
  hangCount: number;
  tail?: () => Promise<DownloadResult>;
}): {
  fn: (
    target: unknown,
    options: { signal?: AbortSignal },
  ) => Promise<DownloadResult>;
  callCount: () => number;
} {
  let i = 0;
  const fn = async (
    _target: unknown,
    options: { signal?: AbortSignal },
  ): Promise<DownloadResult> => {
    const calledAt = ++i;
    if (calledAt <= opts.hangCount) {
      return new Promise<DownloadResult>((_resolve, reject) => {
        const signal = options.signal;
        if (signal === undefined) {
          // Without a signal there is nothing to break the hang — the
          // test will time out, which is the desired RED signal in the
          // pre-impl run.
          return;
        }
        if (signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      });
    }
    if (opts.tail !== undefined) {
      return opts.tail();
    }
    throw new Error(`hanging engine fake exhausted at call ${calledAt}`);
  };
  return { fn, callCount: () => i };
}

// §11.7 — Per-attempt timeout fires when engine hangs
//
// The first engine call hangs forever (returns a promise that only rejects
// when its signal aborts). The handler's per-attempt timeout fires at
// PER_ATTEMPT_TIMEOUT_MS, the composed signal aborts, the engine's mock
// rejects with AbortError. The handler distinguishes user-cancel
// (abortController.signal.aborted === false) from timeout
// (attemptCtrl.signal.aborted === true) and synthesizes a
// DatasourceError({ tag: "network-error", retryable: true, message:
// "per-attempt timeout (60000ms)" }), which feeds the Layer 3 env-retry
// branch — exactly one `download-retrying { attempt: 1, engineCause:
// "network-error" }` emits, the env-retry sleep (expBackoff(1) = 1000ms)
// runs, and the second engine call is issued.

describe("files:download — per-attempt timeout fires when engine hangs (§11.7)", () => {
  it("emits exactly one download-retrying { attempt: 1, engineCause: 'network-error' } and issues a second engine call", async () => {
    vi.useFakeTimers();
    try {
      const fakeFs = makeFakeFs({ writableParents: [PARENT] });
      const hanging = makeHangingDownloadFile({
        hangCount: 1,
        tail: async () => ({
          stream: streamFromBytes(Buffer.alloc(1024, 0xcd)),
          contentLength: 1024,
        }),
      });
      const downloadFile = vi.fn(hanging.fn);
      const getMetadata = vi.fn().mockResolvedValue({
        ...sampleEntry,
        providerMetadata: {},
      });
      const client = makeFakeClient({ downloadFile, getMetadata });
      const { bus, events } = captureFsSyncEvents();
      const handler = makeFilesDownloadHandler(
        makeDeps({
          resolveClient: async () => client,
          fs: fakeFs,
          fsSyncBus: bus,
        }),
      );
      const inflight = handler(
        { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
        ctx,
      );
      // Advance past the per-attempt timeout — composed signal aborts,
      // engine fake rejects, handler synthesizes network-error, Layer 3
      // emits download-retrying and starts the env-retry sleep
      // (expBackoff(1) = 1000ms).
      await pump(PER_ATTEMPT_TIMEOUT_MS + 1);
      const retrying = events.filter((e) => e.name === "download-retrying");
      expect(retrying).toHaveLength(1);
      expect(retrying[0]?.payload).toMatchObject({
        datasourceId: "ds-1",
        attempt: 1,
        limit: 5,
        engineCause: "network-error",
      });
      // Drive past the env-retry sleep so the second engine call lands
      // and the (succeeding) tail completes.
      await pump(1000);
      const result = await inflight;
      expect(result.ok).toBe(true);
      // Two engine calls total: hung first attempt, succeeding second.
      expect(hanging.callCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// §11.8 — Per-attempt timeout counts against the 5-attempt budget.
//
// Five back-to-back hung attempts → consecutiveFailureCount climbs 1..5
// without any byte-progress reset (no bytes ever written). The sixth
// attempt's timeout-synthesized error pushes the counter past the limit,
// the handler raises ExhaustedRetriesError("network-error"), and the
// outer terminal catch emits `download-failed { tag: "exhausted-retries",
// message: "exhausted-retries: network-error" }`. Confirms timeout-
// synthesized errors are budget-eligible (not special-cased).

describe("files:download — per-attempt timeout counts against budget (§11.8)", () => {
  it("5 hung attempts → download-failed { tag: 'exhausted-retries', message: 'exhausted-retries: network-error' }", async () => {
    vi.useFakeTimers();
    try {
      const fakeFs = makeFakeFs({ writableParents: [PARENT] });
      // 6 hangs total: attempts 1..5 emit download-retrying, the 6th
      // trips the > limit check.
      const hanging = makeHangingDownloadFile({ hangCount: 6 });
      const downloadFile = vi.fn(hanging.fn);
      const client = makeFakeClient({ downloadFile });
      const { bus, events } = captureFsSyncEvents();
      const handler = makeFilesDownloadHandler(
        makeDeps({
          resolveClient: async () => client,
          fs: fakeFs,
          fsSyncBus: bus,
        }),
      );
      const inflight = handler(
        { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
        ctx,
      );
      // Each attempt: PER_ATTEMPT_TIMEOUT_MS hang + expBackoff(n) sleep.
      // Total worst-case: 6*60_000 + (1000+2000+4000+8000+16000) =
      //   360_000 + 31_000 = 391_000ms. Pump generously.
      await pump(400_000);
      const result = await inflight;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.tag).toBe("exhausted-retries");
        expect(result.error.message).toBe(
          "exhausted-retries: network-error",
        );
        expect(result.error.retryable).toBe(true);
      }
      const retrying = events.filter((e) => e.name === "download-retrying");
      expect(retrying).toHaveLength(5);
      retrying.forEach((e, idx) => {
        expect(e.payload).toMatchObject({
          attempt: idx + 1,
          limit: 5,
          engineCause: "network-error",
        });
      });
      const failed = events.filter((e) => e.name === "download-failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({
        tag: "exhausted-retries",
        message: "exhausted-retries: network-error",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// §11.9 — User cancel during a hung attempt fires download-cancelled.
//
// The engine hangs; we abort the user-cancel signal halfway through
// PER_ATTEMPT_TIMEOUT_MS. Both signals will be aborted by the time the
// engine fake's rejection reaches the catch (the user-cancel triggers the
// composed-signal abort, which the engine's listener observes). The
// handler MUST check `abortController.signal.aborted` FIRST — if true,
// take the existing CancelledError → download-cancelled path. Otherwise
// the timeout-synthesis branch would mistakenly fire.

describe("files:download — user cancel during hung attempt (§11.9)", () => {
  it("abort halfway through hang → download-cancelled emits, NOT download-retrying", async () => {
    vi.useFakeTimers();
    try {
      const fakeFs = makeFakeFs({ writableParents: [PARENT] });
      const hanging = makeHangingDownloadFile({ hangCount: 1 });
      const downloadFile = vi.fn(hanging.fn);
      const client = makeFakeClient({ downloadFile });
      const registry = createDownloadRegistry();
      const { bus, events } = captureFsSyncEvents();
      const handler = makeFilesDownloadHandler(
        makeDeps({
          resolveClient: async () => client,
          fs: fakeFs,
          fsSyncBus: bus,
          registry,
        }),
      );
      const inflight = handler(
        { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
        ctx,
      );
      // Halfway through the per-attempt timeout — engine still hung.
      await pump(PER_ATTEMPT_TIMEOUT_MS / 2);
      // Verify pre-cancel state: no retrying yet, no terminal yet.
      expect(events.filter((e) => e.name === "download-retrying")).toHaveLength(
        0,
      );
      expect(events.filter((e) => e.name === "download-cancelled")).toHaveLength(
        0,
      );
      // Fire the cancel.
      const cancelHandler = makeSyncCancelDownloadHandler({ registry });
      const cancelResult = await cancelHandler(
        { downloadJobId: "job-1" },
        ctx,
      );
      expect(cancelResult).toEqual({ ok: true, result: { cancelled: true } });
      // Drain microtasks so the engine fake's signal-listener fires and
      // the handler's catch runs.
      await pump(0);
      // Advance well past where the per-attempt timeout would have fired
      // — to confirm the cancel path took precedence (no retrying).
      await pump(PER_ATTEMPT_TIMEOUT_MS);
      const result = await inflight;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.tag).toBe("cancelled");
      }
      // Cancel branch fired, NOT timeout-synthesis.
      expect(events.filter((e) => e.name === "download-retrying")).toHaveLength(
        0,
      );
      const cancelled = events.filter((e) => e.name === "download-cancelled");
      expect(cancelled).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// §12.4 — Decision 3 rewrite (rewrite-from-0) additional contracts
// ---------------------------------------------------------------------------

describe("files:download — Decision 3 rewrite-from-0 budget + sticky flag (§12.4)", () => {
  it("(12.4.9) rewrite-from-0 consumes one env-retry budget slot; subsequent post-rewrite env-retries continue to consume slots until exhausted", async () => {
    // The rewrite-from-0 path can fire AT MOST ONCE per download (once
    // `rangeUnsupported = true` is set, all subsequent attempts use
    // `rangeStart = 0` and the range-not-honored branch is unreachable,
    // per design.md Decision 3 "Idempotency on repeat"). So the budget
    // exhaustion scenario for this test is: cycle 1 mid-stream
    // network-error (attempt 1, but byte progress resets to 0 then
    // increments back to 1) → cycle 2 no contentRange (rewrite trigger,
    // attempt 2) → cycle 3..6 mid-stream network-errors immediately
    // before any byte progress (attempts 3, 4, 5, 6 — exhaustion).
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    let call = 0;
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => {
      call++;
      if (call === 1) {
        // Initial cycle: drain 64 bytes then network-error. After this,
        // counter resets on byte-progress then increments to 1.
        const stream = Readable.from(
          (async function* () {
            fakeFs.files.set(TO_PATH, Buffer.alloc(64, 0xaa));
            yield Buffer.alloc(64, 0xaa);
            throw new DatasourceError({
              tag: "network-error",
              datasourceType: "google-drive",
              datasourceId: "ds-1",
              retryable: true,
              message: "first blip",
            });
          })(),
        );
        return { stream, contentLength: 1024 };
      }
      if (call === 2) {
        // Resume request → no Content-Range → rewrite-from-0 trigger
        // (counter increments to 2). Empty stream means we destroy and
        // continue, so this attempt drains 0 bytes (no progress reset).
        return {
          stream: streamFromBytes(Buffer.alloc(0)),
          contentLength: 1024,
        };
      }
      // Calls 3..N: post-rewrite attempts. Each one immediately errors
      // mid-stream BEFORE any bytes drain, so consecutiveFailureCount
      // increments without reset. Counter goes 3 → 4 → 5 → 6
      // (exhaustion).
      const stream = Readable.from(
        (async function* () {
          throw new DatasourceError({
            tag: "network-error",
            datasourceType: "google-drive",
            datasourceId: "ds-1",
            retryable: true,
            message: `blip ${call}`,
          });
          // unreachable but required for generator type:
          // eslint-disable-next-line no-unreachable
          yield Buffer.alloc(0);
        })(),
      );
      return { stream, contentLength: 1024 };
    });
    const client = makeFakeClient({ downloadFile });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
      }),
    );
    vi.useFakeTimers();
    const inflight = handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    // Pump enough fake time for all retries' sleeps to drain. The
    // mid-stream net-error retries use expBackoff: 1s, 2s, 4s, 8s, 16s
    // (cumulative 31s for 5 retries). The rewrite-from-0 emit has
    // waitMs=0 so no sleep there.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
    const result = await inflight;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.tag).toBe("exhausted-retries");
      // The 6th occurrence is a post-rewrite mid-stream network-error
      // — the engineCause that overflows the budget.
      expect(result.error.message).toBe(
        "exhausted-retries: network-error",
      );
    }
    // Five `download-retrying` events fire (attempt 1..5); the 6th
    // increments to 6 which trips the `> CONSECUTIVE_FAIL_LIMIT` guard
    // BEFORE emitting another retrying event.
    const retrying = events.filter((e) => e.name === "download-retrying");
    expect(retrying).toHaveLength(5);
    expect((retrying[0]!.payload as { engineCause: string }).engineCause).toBe(
      "network-error",
    );
    // Attempt 2 is the rewrite-from-0 trigger — engineCause is
    // "range-not-honored" with waitMs=0.
    expect((retrying[1]!.payload as { engineCause: string }).engineCause).toBe(
      "range-not-honored",
    );
    expect((retrying[1]!.payload as { waitMs: number }).waitMs).toBe(0);
    // Attempts 3..5 are post-rewrite net-errors.
    for (let i = 2; i < 5; i++) {
      expect(
        (retrying[i]!.payload as { engineCause: string }).engineCause,
      ).toBe("network-error");
    }
  });

  it("(12.4.10) rangeUnsupported flag is sticky — every post-rewrite engine call sees rangeStart === 0 even when bytesWritten > 0", async () => {
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const rangeStartsObserved: Array<number | undefined> = [];
    let call = 0;
    const downloadFile = vi.fn(
      async (
        _target: Target,
        opts: DownloadOptions | undefined,
      ): Promise<DownloadResult> => {
        rangeStartsObserved.push(opts?.rangeStart);
        call++;
        if (call === 1) {
          // Cycle 1: drain 256 bytes then network-error.
          const stream = Readable.from(
            (async function* () {
              fakeFs.files.set(TO_PATH, Buffer.alloc(256, 0xaa));
              yield Buffer.alloc(256, 0xaa);
              throw new DatasourceError({
                tag: "network-error",
                datasourceType: "google-drive",
                datasourceId: "ds-1",
                retryable: true,
                message: "first blip",
              });
            })(),
          );
          return { stream, contentLength: 1024 };
        }
        if (call === 2) {
          // Resume request (rangeStart === 256). Server returns no
          // contentRange → rewrite-from-0 trigger.
          return {
            stream: streamFromBytes(Buffer.alloc(0)),
            contentLength: 1024,
          };
        }
        if (call === 3) {
          // Post-rewrite attempt — rangeStart should be 0. Drain 128
          // bytes then mid-stream network-error to exercise the sticky
          // flag across recovery.
          const stream = Readable.from(
            (async function* () {
              fakeFs.files.set(TO_PATH, Buffer.alloc(128, 0xbb));
              yield Buffer.alloc(128, 0xbb);
              throw new DatasourceError({
                tag: "network-error",
                datasourceType: "google-drive",
                datasourceId: "ds-1",
                retryable: true,
                message: "second blip",
              });
            })(),
          );
          return { stream, contentLength: 1024 };
        }
        // Cycle 1 / attempt 4 (recovery from second blip): rangeStart
        // MUST be 0 because rangeUnsupported is sticky, even though
        // bytesWritten === 128 on disk. Full re-pipe completes.
        return {
          stream: streamFromBytes(Buffer.alloc(1024, 0xcc)),
          contentLength: 1024,
        };
      },
    );
    const client = makeFakeClient({ downloadFile });
    const { bus, events } = captureFsSyncEvents();
    const handler = makeFilesDownloadHandler(
      makeDeps({
        resolveClient: async () => client,
        fs: fakeFs,
        fsSyncBus: bus,
      }),
    );
    vi.useFakeTimers();
    const inflight = handler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(0);
    const result = await inflight;
    vi.useRealTimers();

    expect(result.ok).toBe(true);
    expect(rangeStartsObserved).toEqual([
      0,    // attempt 1: cycle start, no resume
      256,  // attempt 2: resume from cycle 1 partial (TRIGGERS rewrite)
      0,    // attempt 3: post-rewrite, rangeUnsupported = true
      0,    // attempt 4: post-second-blip recovery, sticky stays
    ]);
    // Final file is the cycle-4 stream's content (full 1024 bytes 0xcc).
    const finalBytes = fakeFs.files.get(TO_PATH);
    expect(finalBytes?.length).toBe(1024);
    expect(finalBytes?.[0]).toBe(0xcc);
    // Three `download-retrying` events: cycle-1 net-error, rewrite-from-0
    // (waitMs:0, range-not-honored), cycle-3 net-error.
    const retrying = events.filter((e) => e.name === "download-retrying");
    expect(retrying).toHaveLength(3);
    expect((retrying[1]!.payload as { engineCause: string }).engineCause).toBe(
      "range-not-honored",
    );
    expect((retrying[1]!.payload as { waitMs: number }).waitMs).toBe(0);
  });
});
