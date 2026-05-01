// Unit tests for the `downloads:list-active` RPC handler — projects the
// in-memory `DownloadRegistry` snapshot (internal `DownloadJobEntry`,
// which carries an `AbortController`) to the IPC-exposed `DownloadJob`
// shape (no controller). Per add-engine-rename-download §14.1.
//
// The handler:
// - Accepts an empty params object.
// - Returns `{ ok: true, result: { jobs } }` where `jobs` is ordered by
//   `startedAt` ascending — that ordering is enforced by the registry's
//   `snapshot()` itself; the handler trusts it.
// - Strips `abortController` from each entry — the IPC-exposed shape
//   never carries the controller (it would not survive JSON anyway and
//   the renderer never needs it).
// - Never blocks on engine I/O; reads the registry atomically.
//
// Spec scenarios driven by these tests (specs/fs-sync-service/spec.md):
// - "Empty registry" (line 191).
// - "Two in-flight downloads" (line 196), `startedAt` ascending.

import { describe, expect, it, vi } from "vitest";

import * as nodePath from "node:path";

import type { DatasourceClient, DownloadResult } from "@ft5/fs-datasource-engine";
import type { DatasourceFileEntry, DatasourceType } from "@ft5/ipc-contracts";

import { createDownloadRegistry } from "../../downloads/registry.js";
import { createEventBus } from "../../events/event-bus.js";
import {
  makeFilesDownloadHandler,
  type EngineBusEvent,
  type EngineBusSubscriber,
  type FilesDownloadDeps,
  type FsBoundary,
  type HashComputer,
} from "../files-download.js";
import { makeDownloadsListActiveHandler } from "../downloads-list-active.js";
import { createSubscriptionRegistry } from "../../ipc/subscriptions.js";
import type { Connection } from "../../ipc/server.js";

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

describe("downloads:list-active handler — §14.1 (unit)", () => {
  it("empty registry: returns { ok: true, result: { jobs: [] } }", async () => {
    const registry = createDownloadRegistry();
    const handler = makeDownloadsListActiveHandler({ registry });

    const result = await handler({}, ctx);

    expect(result).toEqual({ ok: true, result: { jobs: [] } });
  });

  it("returns the snapshot ordered by startedAt ascending — even when entries were inserted in reverse order", async () => {
    const registry = createDownloadRegistry();
    // Insert the LATER job first; the registry's `snapshot()` orders by
    // `startedAt`, so the handler MUST surface them oldest-first.
    registry.set({
      downloadJobId: "job-newer",
      datasourceId: "ds-1",
      sourcePath: "/b.pdf",
      targetPath: "/local/b.pdf",
      bytesDownloaded: 50,
      contentLength: 200,
      startedAt: 2000,
      abortController: new AbortController(),
    });
    registry.set({
      downloadJobId: "job-older",
      datasourceId: "ds-1",
      sourcePath: "/a.pdf",
      targetPath: "/local/a.pdf",
      bytesDownloaded: 10,
      contentLength: 100,
      startedAt: 1000,
      abortController: new AbortController(),
    });
    const handler = makeDownloadsListActiveHandler({ registry });

    const result = await handler({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.jobs.map((j) => j.downloadJobId)).toEqual([
      "job-older",
      "job-newer",
    ]);
    expect(result.result.jobs.map((j) => j.startedAt)).toEqual([1000, 2000]);
  });

  it("strips `abortController` from every entry — the IPC-exposed DownloadJob shape never carries the controller", async () => {
    const registry = createDownloadRegistry();
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    registry.set({
      downloadJobId: "j1",
      datasourceId: "ds-1",
      sourcePath: "/a.pdf",
      targetPath: "/local/a.pdf",
      bytesDownloaded: 10,
      contentLength: 100,
      startedAt: 1000,
      abortController: ac1,
    });
    registry.set({
      downloadJobId: "j2",
      datasourceId: "ds-2",
      sourcePath: "/b.pdf",
      targetPath: "/local/b.pdf",
      bytesDownloaded: 20,
      contentLength: 200,
      startedAt: 2000,
      abortController: ac2,
    });
    const handler = makeDownloadsListActiveHandler({ registry });

    const result = await handler({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const job of result.result.jobs) {
      // Property-level absence — `toEqual` would silently pass with
      // `abortController: undefined`. We assert the key is not on the
      // object at all so the wire shape is clean.
      expect(Object.prototype.hasOwnProperty.call(job, "abortController")).toBe(
        false,
      );
    }
    // And the projection preserves every other field verbatim.
    expect(result.result.jobs[0]).toEqual({
      downloadJobId: "j1",
      datasourceId: "ds-1",
      sourcePath: "/a.pdf",
      targetPath: "/local/a.pdf",
      bytesDownloaded: 10,
      contentLength: 100,
      startedAt: 1000,
    });
    expect(result.result.jobs[1]).toEqual({
      downloadJobId: "j2",
      datasourceId: "ds-2",
      sourcePath: "/b.pdf",
      targetPath: "/local/b.pdf",
      bytesDownloaded: 20,
      contentLength: 200,
      startedAt: 2000,
    });
  });

  it("preserves null contentLength (provider did not advertise total) verbatim", async () => {
    const registry = createDownloadRegistry();
    registry.set({
      downloadJobId: "j-indeterminate",
      datasourceId: "ds-1",
      sourcePath: "/streaming.bin",
      targetPath: "/local/streaming.bin",
      bytesDownloaded: 1234,
      contentLength: null,
      startedAt: 500,
      abortController: new AbortController(),
    });
    const handler = makeDownloadsListActiveHandler({ registry });

    const result = await handler({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.jobs).toHaveLength(1);
    expect(result.result.jobs[0]?.contentLength).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §14.3 — small integration test exercising both §13's download handler
// AND §14's list-active handler. Two concurrent downloads are kept open
// (their `downloadFile` promise hangs on a release-gate) so the registry
// holds both entries; we drive `onProgress` through each before calling
// list-active to assert the live `bytesDownloaded` values.
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
  return {
    files,
    accessibleParents,
    access: async (path) => {
      if (!accessibleParents.has(path)) {
        throw new Error(`EACCES: ${path}`);
      }
    },
    statSize: async (path) => files.get(path)?.length ?? 0,
    createWriteStream: () => {
      // Never reached in this test — the gated `downloadFile` never returns.
      throw new Error("createWriteStream should not be called in §14.3");
    },
    pipeline: async () => {
      throw new Error("pipeline should not be called in §14.3");
    },
  };
}

function makeEngineBus(): EngineBusSubscriber {
  return {
    subscribe() {
      return () => undefined;
    },
  };
}

function makeHash(): HashComputer {
  return { hashFile: async () => "deadbeef" };
}

const HOMEDIR = nodePath.resolve(nodePath.sep, "home", "alice");
const PARENT = nodePath.join(HOMEDIR, "Downloads");
const TO_PATH_A = nodePath.join(PARENT, "a.pdf");
const TO_PATH_B = nodePath.join(PARENT, "b.pdf");

describe("downloads:list-active — §14.3 (integration with §13 files:download)", () => {
  it("two concurrent in-flight downloads (started 1s apart) appear in startedAt order with their current bytesDownloaded", async () => {
    const registry = createDownloadRegistry();
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const fsSyncBus = createEventBus();
    const engineBus = makeEngineBus();

    // Both downloads hang inside the gated `downloadFile` so the
    // registry holds both entries when list-active is invoked. Each
    // captures its `onProgress` so the test can drive
    // bytesDownloaded mutations.
    const onProgressByPath: Record<
      string,
      ((loaded: number, total: number | null) => void) | undefined
    > = {};
    // Per-path hang gate. Each call records its onProgress and parks
    // on a never-resolving promise so the registry holds both entries
    // for the duration of the assertion.
    const downloadFile = vi.fn((target, options) => {
      const sourcePath =
        target.kind === "path" ? target.path : `handle:${target.handle}`;
      onProgressByPath[sourcePath] = options?.onProgress;
      // Return a never-settling Promise — the await inside the handler
      // parks here forever (test process exit reaps it).
      return new Promise<DownloadResult>(() => undefined);
    });
    const sampleEntry: DatasourceFileEntry<"google-drive"> = {
      handle: "h-1",
      kind: "file",
      name: "x",
      path: "/x",
      size: 1024,
      mimeFamily: "document",
      modifiedAt: Date.parse("2026-04-28T00:00:00.000Z"),
      providerMetadata: {},
    };
    const client = makeFakeClient({
      downloadFile,
      getMetadata: vi.fn().mockResolvedValue(sampleEntry),
    });

    // Deterministic clock: first download → startedAt=1000,
    // second → startedAt=2000.
    const clock = (() => {
      const ticks = [1000, 2000];
      let i = 0;
      return () => ticks[Math.min(i++, ticks.length - 1)] as number;
    })();

    const downloadDeps: FilesDownloadDeps = {
      resolveClient: async () => client,
      registry,
      fsSyncBus,
      engineBus,
      fs: fakeFs,
      hash: makeHash(),
      randomUUID: (() => {
        let n = 0;
        return () => `job-${++n}`;
      })(),
      now: clock,
      homedir: () => HOMEDIR,
    };
    const downloadHandler = makeFilesDownloadHandler(downloadDeps);
    const listHandler = makeDownloadsListActiveHandler({ registry });

    // Kick off both downloads (do NOT await — they hang on the gate).
    // Attach a no-op handler to the inflight promises to suppress
    // unhandled-rejection warnings when the test process exits while
    // they are still pending.
    const inflightA = downloadHandler(
      { datasourceId: "ds-1", path: "/a.pdf", toPath: TO_PATH_A },
      ctx,
    );
    const inflightB = downloadHandler(
      { datasourceId: "ds-1", path: "/b.pdf", toPath: TO_PATH_B },
      ctx,
    );
    inflightA.catch(() => undefined);
    inflightB.catch(() => undefined);

    // Yield enough microtasks for both handlers to finish their
    // synchronous prelude (validation, registry insertion, then
    // entering the engine call). validateToPath awaits canWrite()
    // (one microtask), then resolveClient (another), then
    // registry.set runs synchronously, then engineBus.subscribe runs,
    // then `await client.downloadFile(...)` parks on the gate.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(registry.size()).toBe(2);

    // Drive progress through each captured onProgress so list-active
    // surfaces live `bytesDownloaded` numbers — proving it pulls from
    // the registry's mutated state, not a stale snapshot.
    onProgressByPath["/a.pdf"]?.(256, 1024);
    onProgressByPath["/b.pdf"]?.(512, 2048);

    const result = await listHandler({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.jobs).toHaveLength(2);
    // Ordered by startedAt ascending — the older job (1000) first.
    expect(result.result.jobs[0]).toMatchObject({
      downloadJobId: "job-1",
      datasourceId: "ds-1",
      sourcePath: "/a.pdf",
      targetPath: TO_PATH_A,
      bytesDownloaded: 256,
      contentLength: 1024,
      startedAt: 1000,
    });
    expect(result.result.jobs[1]).toMatchObject({
      downloadJobId: "job-2",
      datasourceId: "ds-1",
      sourcePath: "/b.pdf",
      targetPath: TO_PATH_B,
      bytesDownloaded: 512,
      contentLength: 2048,
      startedAt: 2000,
    });
    // No abortController on the wire shape.
    for (const job of result.result.jobs) {
      expect(
        Object.prototype.hasOwnProperty.call(job, "abortController"),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §15.1 — `downloading` events flow through `sync:subscribe-events`
// SubscriptionRegistry to a connected client; the bus subscription
// transformer wires up engine-bus → fs-sync transformation (per §13.21);
// the SubscriptionRegistry forwards the fs-sync event to subscribers.
// ---------------------------------------------------------------------------

describe("§15.1 — `downloading` event reaches sync:subscribe-events client", () => {
  it("an engine-bus `downloading` event drives a fs-sync `downloading` event with the downloadJobId-keyed wire shape — delivered to a subscribed client through the SubscriptionRegistry", async () => {
    const registry = createDownloadRegistry();
    const fakeFs = makeFakeFs({ writableParents: [PARENT] });
    const fsSyncBus = createEventBus();
    const engineSubscribers = new Set<(e: EngineBusEvent) => void>();
    const engineBus: EngineBusSubscriber = {
      subscribe(handler) {
        engineSubscribers.add(handler);
        return () => engineSubscribers.delete(handler);
      },
    };
    // Hang the engine call; the bus subscription is what we drive.
    const downloadFile = vi.fn(
      () => new Promise<DownloadResult>(() => undefined),
    );
    const client = makeFakeClient({
      downloadFile,
      getMetadata: vi.fn().mockResolvedValue({
        handle: "h-1",
        kind: "file" as const,
        name: "welcome.pdf",
        path: "/welcome.pdf",
        size: 1024,
        mimeFamily: "document" as const,
        modifiedAt: Date.parse("2026-04-28T00:00:00.000Z"),
        providerMetadata: {},
      }),
    });

    const downloadHandler = makeFilesDownloadHandler({
      resolveClient: async () => client,
      registry,
      fsSyncBus,
      engineBus,
      fs: fakeFs,
      hash: makeHash(),
      randomUUID: () => "job-A",
      now: () => 100,
      homedir: () => HOMEDIR,
    });

    // Wire the SubscriptionRegistry to the bus and subscribe a fake
    // connection — the same mechanism end-to-end.test.ts uses.
    const subs = createSubscriptionRegistry();
    subs.attachBus(fsSyncBus);
    interface CapturedEvent {
      readonly name: string;
      readonly payload: unknown;
    }
    const captured: CapturedEvent[] = [];
    const conn: Connection = {
      id: 42,
      closed: false,
      sendEvent: (e) => captured.push(e),
    };
    subs.subscribe(conn);

    // Kick off the download (hangs); wait for the bus subscription to register.
    void downloadHandler(
      { datasourceId: "ds-1", path: "/welcome.pdf", toPath: TO_PATH_A },
      ctx,
    );
    await new Promise((r) => setImmediate(r));
    expect(engineSubscribers.size).toBe(1);

    // Fire 3 engine-bus `downloading` events — assert the connection
    // receives 3 fs-sync `downloading` events with the transformed,
    // downloadJobId-keyed payload (NOT the engine bus's
    // `{ datasourceId, path, loaded, total }` shape).
    for (const handler of engineSubscribers) {
      handler({
        event: "downloading",
        datasourceId: "ds-1",
        streaming: true,
        payload: { path: "/welcome.pdf", loaded: 256, total: 1024 },
      });
      handler({
        event: "downloading",
        datasourceId: "ds-1",
        streaming: true,
        payload: { path: "/welcome.pdf", loaded: 512, total: 1024 },
      });
      handler({
        event: "downloading",
        datasourceId: "ds-1",
        streaming: true,
        payload: { path: "/welcome.pdf", loaded: 768, total: 1024 },
      });
    }

    const downloading = captured.filter((e) => e.name === "downloading");
    // Throttling lives upstream at the engine bus's coalescer — the
    // fs-sync layer does NOT add a second throttle. So N engine events
    // → N fs-sync events arrive at the subscriber. The test asserts
    // the 1:1 passthrough behaviour (matches the upload coalescer's
    // pattern: one transformation, no double-throttle at fs-sync).
    expect(downloading).toHaveLength(3);
    // Wire shape is fs-sync's downloadJobId-keyed payload, NOT the
    // engine bus's `{ loaded, total }` shape.
    expect(downloading[0]?.payload).toEqual({
      downloadJobId: "job-A",
      datasourceId: "ds-1",
      progress: 25,
      path: "/welcome.pdf",
      bytesLoaded: 256,
      bytesTotal: 1024,
    });
    expect(downloading[1]?.payload).toEqual({
      downloadJobId: "job-A",
      datasourceId: "ds-1",
      progress: 50,
      path: "/welcome.pdf",
      bytesLoaded: 512,
      bytesTotal: 1024,
    });
    expect(downloading[2]?.payload).toEqual({
      downloadJobId: "job-A",
      datasourceId: "ds-1",
      progress: 75,
      path: "/welcome.pdf",
      bytesLoaded: 768,
      bytesTotal: 1024,
    });
  });
});
