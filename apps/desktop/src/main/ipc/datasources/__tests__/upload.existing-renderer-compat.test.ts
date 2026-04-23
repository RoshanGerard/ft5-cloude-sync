// wire-fs-sync-service task 8.3 / 8.4 — renderer-compat contract test.
//
// 8.2 changed the format of `DatasourcesUploadResponse.transactionId`:
// previously it was main-process-minted like `tx-${Date.now()}-${n}`; it
// is now the opaque `jobId` produced by the fs-sync-service (UUID-ish).
// This test guards against any renderer-side or preload-side assumption
// about the shape of that string — if something, somewhere, started
// slicing/regexing the transactionId, this test would start failing.
//
// Scope: this is an IPC-layer compat check, NOT a full React render test.
// We exercise the two load-bearing seams:
//
//   (1) main-handler → response.transactionId identity  — `handleDatasourcesUpload`
//       returns the service's jobId unchanged (no prefix, no transform).
//
//   (2) preload → renderer subscriber filter            — the preload's
//       `onUploadProgress(transactionId, cb)` matches by strict `===`,
//       so an opaque server-minted id must round-trip without rewriting.
//
// The `store.tsx` layer above (2) is a pure pass-through — nothing in it
// parses the id — so if (1) and (2) hold, the whole path holds.
//
// This test also includes a source-level grep guard: the renderer +
// preload sources must contain no shape-dependent operations on
// `transactionId` (match/split/startsWith/slice/replace/substring).
// The mirror of the existing "zero engine coupling" grep in upload.test.ts.
//
// RED→GREEN note: this test is expected to PASS on first run. 8.2's
// behaviour already treats transactionId opaquely; the test exists as a
// regression guard so that if someone re-introduces a format dependency
// (say, `transactionId.startsWith("tx-")` somewhere in the renderer),
// CI catches it immediately rather than at runtime in a packaged build.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock `electron` BEFORE importing the preload module. The preload has a
// top-level `contextBridge.exposeInMainWorld` side-effect, so we need the
// mock in place at module load. Pattern reused from
// `apps/desktop/src/preload/__tests__/exposed-api.test.ts`.
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import { contextBridge, ipcRenderer } from "electron";

import {
  DATASOURCES_CHANNELS,
  type DatasourcesUploadProgressEvent,
  type DatasourcesUploadRequest,
  type DatasourcesUploadResponse,
} from "@ft5/ipc-contracts";
import type { SyncEnqueueUploadResponse } from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { handleDatasourcesUpload } from "../upload.js";

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

interface UploadDepsShape {
  showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  syncClient: Pick<SyncClient, "enqueueUpload">;
}

type UploadHandler = (
  req: DatasourcesUploadRequest,
  deps: UploadDepsShape,
) => Promise<DatasourcesUploadResponse>;

const handler = handleDatasourcesUpload as unknown as UploadHandler;

function makeSyncClient(jobId: string): {
  syncClient: UploadDepsShape["syncClient"];
  enqueueUpload: ReturnType<typeof vi.fn>;
} {
  const enqueueUpload = vi.fn(
    async (): Promise<SyncEnqueueUploadResponse> => ({ jobId }),
  );
  return {
    syncClient: { enqueueUpload } as unknown as UploadDepsShape["syncClient"],
    enqueueUpload,
  };
}

// Minimal shape matching what the preload exposes — only the pieces this
// test exercises. Mirrors the `ExposedApi` in `exposed-api.test.ts`.
type ExposedDatasourceApi = {
  datasources: {
    upload: (req: unknown) => Promise<DatasourcesUploadResponse>;
    onUploadProgress: (
      transactionId: string,
      callback: (event: DatasourcesUploadProgressEvent) => void,
    ) => () => void;
  };
};

async function loadExposedDatasourceApi(): Promise<ExposedDatasourceApi> {
  await import("../../../../preload/index.js");
  const exposeMock = contextBridge.exposeInMainWorld as unknown as ReturnType<
    typeof vi.fn
  >;
  return exposeMock.mock.calls[0]![1] as ExposedDatasourceApi;
}

// Deliberately-not-`tx-` job ids. If the preload (or anything else) was
// parsing the transactionId as `tx-<timestamp>-<seq>`, none of these
// would survive the round trip.
const OPAQUE_JOB_IDS = [
  "01HQZX5K7P9M3N8R4T6V2W1YAB",            // ULID-shape
  "ce4d9b1e-7a2f-4c6b-9e3d-0f8a1b2c3d4e",  // UUID-shape
  "job_abc123",                              // prefixed-but-not-`tx-`
  "opaque-with-dashes-and-lots-of-segments",
];

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("upload renderer-compat — transactionId is opaque end-to-end", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // (A) Handler identity — service jobId flows out as transactionId untouched.
  // ---------------------------------------------------------------------------

  it.each(OPAQUE_JOB_IDS)(
    "returns the service jobId as-is for transactionId (no prefix/transform): %s",
    async (jobId) => {
      const { syncClient } = makeSyncClient(jobId);
      const showOpenDialog = vi.fn().mockResolvedValue({
        canceled: false,
        filePaths: ["C:/mock/file.txt"],
      });

      const response = await handler(
        { datasourceId: "ds-1" },
        { showOpenDialog, syncClient },
      );

      expect(response.transactionId).toBe(jobId);
      // Strict identity, not partial match — the handler must NOT wrap,
      // decorate, or reformat the id.
      expect(response).toEqual({ transactionId: jobId });
    },
  );

  // ---------------------------------------------------------------------------
  // (B) Preload filter — the subscriber gate is strict equality on an opaque
  //     string. A matching opaque id is delivered; a non-matching opaque id
  //     is dropped — regardless of whether either starts with `tx-`.
  // ---------------------------------------------------------------------------

  it("preload onUploadProgress delivers an event whose transactionId matches the subscribed opaque id, unchanged", async () => {
    const exposed = await loadExposedDatasourceApi();
    const onMock = ipcRenderer.on as unknown as ReturnType<typeof vi.fn>;

    const subscribedId = "ce4d9b1e-7a2f-4c6b-9e3d-0f8a1b2c3d4e";
    const callback = vi.fn();

    exposed.datasources.onUploadProgress(subscribedId, callback);

    const [, listener] = onMock.mock.calls[0]!;
    const matching: DatasourcesUploadProgressEvent = {
      transactionId: subscribedId,
      bytesUploaded: 1024,
      bytesTotal: 4096,
      status: "uploading",
    };
    (listener as (ev: unknown, p: DatasourcesUploadProgressEvent) => void)(
      {},
      matching,
    );

    // Callback fired exactly once, with the payload *identity-preserved*.
    // If the preload transformed transactionId (stripped a prefix, parsed
    // digits, whatever), the payload that reaches the renderer would no
    // longer `===` the one we sent.
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(matching);
    const delivered = callback.mock.calls[0]![0] as DatasourcesUploadProgressEvent;
    expect(delivered.transactionId).toBe(subscribedId);
  });

  it("preload onUploadProgress drops an event bearing a different opaque id (strict equality, not prefix match)", async () => {
    const exposed = await loadExposedDatasourceApi();
    const onMock = ipcRenderer.on as unknown as ReturnType<typeof vi.fn>;

    // Two ids that share a structural prefix but are not equal. If anything
    // matched by prefix / startsWith, the "other" event would leak through.
    const subscribedId = "01HQZX5K7P9M3N8R4T6V2W1YAB";
    const otherId = "01HQZX5K7P9M3N8R4T6V2W1YZZ";

    const callback = vi.fn();
    exposed.datasources.onUploadProgress(subscribedId, callback);

    const [, listener] = onMock.mock.calls[0]!;
    const differentEvent: DatasourcesUploadProgressEvent = {
      transactionId: otherId,
      bytesUploaded: 1,
      bytesTotal: 10,
      status: "uploading",
    };
    (listener as (ev: unknown, p: DatasourcesUploadProgressEvent) => void)(
      {},
      differentEvent,
    );

    expect(callback).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (C) End-to-end round trip — the handler's return value, subscribed via
  //     the preload, receives the bridge-translated progress event unchanged.
  //     This is what an actual renderer call site does: `const { transactionId }
  //     = await window.api.datasources.upload(req); window.api.datasources.
  //     onUploadProgress(transactionId, cb);` — and it must work regardless of
  //     what shape the service chose for jobId.
  // ---------------------------------------------------------------------------

  it("handler's opaque transactionId flows to a preload subscriber without transformation (end-to-end)", async () => {
    const jobId = "ce4d9b1e-7a2f-4c6b-9e3d-0f8a1b2c3d4e";
    const { syncClient } = makeSyncClient(jobId);
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ["C:/mock/file.txt"],
    });

    // (1) Simulate the renderer's upload() call: get back a transactionId.
    const response = await handler(
      { datasourceId: "ds-1" },
      { showOpenDialog, syncClient },
    );

    // (2) Simulate the renderer handing that same transactionId back to
    //     the preload's onUploadProgress subscriber.
    const exposed = await loadExposedDatasourceApi();
    const onMock = ipcRenderer.on as unknown as ReturnType<typeof vi.fn>;
    const callback = vi.fn();
    exposed.datasources.onUploadProgress(response.transactionId, callback);

    // (3) Simulate the event-bridge translating a service job-progress
    //     into a DatasourcesUploadProgressEvent with transactionId = jobId.
    const [channel, listener] = onMock.mock.calls[0]!;
    expect(channel).toBe(DATASOURCES_CHANNELS.uploadProgress);

    const progress: DatasourcesUploadProgressEvent = {
      transactionId: jobId,
      bytesUploaded: 1024,
      bytesTotal: 4096,
      status: "uploading",
    };
    (listener as (ev: unknown, p: DatasourcesUploadProgressEvent) => void)(
      {},
      progress,
    );

    // (4) The callback must have received the identical payload.
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(progress);
  });

  // ---------------------------------------------------------------------------
  // (D) Source-level guard — renderer + preload source must not parse
  //     transactionId. Mirrors the existing "zero engine coupling" grep in
  //     upload.test.ts. If someone later adds `transactionId.startsWith(...)`
  //     or a regex match on it anywhere in these dirs, this test flags it.
  // ---------------------------------------------------------------------------

  it("renderer + preload sources contain no shape-dependent operations on transactionId", () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // apps/desktop/src/main/ipc/datasources/__tests__ → apps/desktop/src
    const srcRoot = path.resolve(__dirname, "../../../..");

    // Files to scan: the preload and the renderer tree. We do NOT scan the
    // main process — the main-side contract is covered in (A).
    const filesToScan: string[] = [
      path.join(srcRoot, "preload", "index.ts"),
      path.join(srcRoot, "renderer", "src", "features", "datasources", "store.tsx"),
      path.join(srcRoot, "renderer", "src", "types", "window-api.d.ts"),
    ];

    // Any call-syntax pattern of the form `<something-containing-transactionId>.<stringOp>(`
    // where stringOp is one that depends on the internal shape of the id.
    // This catches `transactionId.startsWith("tx-")`, `foo.transactionId.match(/.../)`,
    // `response.transactionId.split("-")`, etc.
    const forbidden =
      /transactionId[^;\n{}]*\.(match|split|startsWith|endsWith|slice|substring|replace|indexOf|search)\s*\(/;

    for (const file of filesToScan) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} must treat transactionId as opaque`).not.toMatch(
        forbidden,
      );
    }

    // Additionally, flag any literal regex on `transactionId` values — e.g.
    // `/tx-\d+-\d+/.test(transactionId)` — which is how an implicit format
    // dependency most often creeps in.
    const forbiddenRegexTest = /\/[^/\n]*\/\s*\.test\s*\([^)]*transactionId/;
    for (const file of filesToScan) {
      const src = readFileSync(file, "utf8");
      expect(
        src,
        `${file} must not regex-test a transactionId`,
      ).not.toMatch(forbiddenRegexTest);
    }
  });
});
