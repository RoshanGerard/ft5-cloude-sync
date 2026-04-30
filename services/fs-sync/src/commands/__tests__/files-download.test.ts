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

import type { DatasourceClient, DownloadResult } from "@ft5/fs-datasource-engine";
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

describe("files:download — range-not-honored detection (§13.7, §13.8)", () => {
  it("on retry where contentRange === undefined: does NOT pipe; emits download-failed { tag:'other', message:'range not supported on this resource' }; partial file left on disk", async () => {
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
      // Provider IGNORES the Range header — returns 200 OK with full body.
      return {
        stream: streamFromBytes(Buffer.alloc(1024, 0xbb)),
        contentLength: 1024,
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
      expect(result.error.message).toBe("range not supported on this resource");
    }
    const terminal = events.filter((e) => e.name === "download-failed");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.payload).toMatchObject({
      tag: "other",
      message: "range not supported on this resource",
    });
    // Partial file remains on disk (not auto-deleted).
    expect(fakeFs.files.get(TO_PATH)?.length).toBe(512);
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
    const downloadFile = vi.fn(async (): Promise<DownloadResult> => {
      throw new DatasourceError({
        tag: "network-error",
        datasourceType: "google-drive",
        datasourceId: "ds-1",
        retryable: true,
        message: "ECONNRESET",
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
  it("transformDownloadingEvent: engine `{ path, loaded, total }` → fs-sync `{ downloadJobId, datasourceId, progress, path }` with progress = floor((loaded/total)*100)", () => {
    const out = transformDownloadingEvent(
      { path: "/welcome.pdf", loaded: 524288, total: 1048576 },
      { downloadJobId: "job-A", datasourceId: "ds-1" },
    );
    expect(out).toEqual({
      downloadJobId: "job-A",
      datasourceId: "ds-1",
      progress: 50,
      path: "/welcome.pdf",
    });
  });

  it("transformDownloadingEvent: total === null → progress = 0 (indeterminate)", () => {
    const out = transformDownloadingEvent(
      { path: "/welcome.pdf", loaded: 1234, total: null },
      { downloadJobId: "job-A", datasourceId: "ds-1" },
    );
    expect(out.progress).toBe(0);
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
    };
    expect(sample.downloadJobId).toBe("job-A");
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

describe("DELETE_ON_TERMINAL (§3.3, Decision 6 disposition policy)", () => {
  it("contains RangeNotHonoredError", () => {
    expect(DELETE_ON_TERMINAL.has(RangeNotHonoredError)).toBe(true);
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

  it("has exactly three members (catches future accidental additions)", () => {
    expect(DELETE_ON_TERMINAL.size).toBe(3);
  });
});
