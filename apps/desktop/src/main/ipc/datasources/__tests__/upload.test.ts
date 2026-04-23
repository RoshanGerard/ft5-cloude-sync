// wire-fs-sync-service task 8.1 — RED test for the upload handler rewrite.
//
// After task 8.2, `handleDatasourcesUpload` is a thin proxy:
//   (a) open a single-file picker via `dialog.showOpenDialog`
//   (b) call `syncClient.enqueueUpload({ datasourceId, sourcePath,
//       targetPath, conflictPolicy: "overwrite" })`
//   (c) return `{ transactionId: jobId }`
//
// The handler must not touch `@ft5/fs-datasource-engine`, the
// credential store, or the engine factory — progress events for the
// renderer flow through the sync event-bridge (section 7), not a
// handler-owned `sendProgress` closure. The old ~250-line setup
// (in-memory DB, engine init, fixture seeding, factory spies) is gone
// with those couplings.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  DatasourcesUploadRequest,
  DatasourcesUploadResponse,
} from "@ft5/ipc-contracts";
import type {
  SyncEnqueueUploadRequest,
  SyncEnqueueUploadResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { handleDatasourcesUpload } from "../upload.js";

// The NEW UploadDeps shape the 8.2 rewrite will ship. We declare it
// locally so these tests compile against the transitional handler
// signature — the cast happens once at the top via `handler`.
interface NewUploadDeps {
  showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  nextTransactionId?: () => string;
  syncClient: Pick<SyncClient, "enqueueUpload">;
}

type UploadHandler = (
  req: DatasourcesUploadRequest,
  deps: NewUploadDeps,
) => Promise<DatasourcesUploadResponse>;

const handler = handleDatasourcesUpload as unknown as UploadHandler;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function makeSyncClient(
  impl: (
    params: SyncEnqueueUploadRequest,
  ) => Promise<SyncEnqueueUploadResponse> = async () => ({ jobId: "job-abc" }),
): {
  syncClient: NewUploadDeps["syncClient"];
  enqueueUpload: ReturnType<typeof vi.fn>;
} {
  const enqueueUpload = vi.fn(impl);
  return {
    syncClient: { enqueueUpload } as unknown as NewUploadDeps["syncClient"],
    enqueueUpload,
  };
}

describe("handleDatasourcesUpload — service proxy", () => {
  // -------------------------------------------------------------------------
  // Behaviour assertions — these drive the 8.2 rewrite.
  // -------------------------------------------------------------------------

  it("calls syncClient.enqueueUpload with derived target + overwrite policy, and returns { transactionId: jobId }", async () => {
    const { syncClient, enqueueUpload } = makeSyncClient(async () => ({
      jobId: "job-abc",
    }));
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ["C:/mock/file-a.txt"],
    });

    const response = await handler(
      { datasourceId: "ds-1" },
      { showOpenDialog, syncClient },
    );

    expect(enqueueUpload).toHaveBeenCalledTimes(1);
    expect(enqueueUpload).toHaveBeenCalledWith({
      datasourceId: "ds-1",
      sourcePath: "C:/mock/file-a.txt",
      targetPath: "/file-a.txt",
      conflictPolicy: "overwrite",
    });
    expect(response).toEqual({ transactionId: "job-abc" });
  });

  it("derives targetPath from the basename of a posix-style sourcePath", async () => {
    const { syncClient, enqueueUpload } = makeSyncClient(async () => ({
      jobId: "job-posix",
    }));
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ["/home/user/doc.pdf"],
    });

    await handler(
      { datasourceId: "ds-2" },
      { showOpenDialog, syncClient },
    );

    expect(enqueueUpload).toHaveBeenCalledTimes(1);
    const call = enqueueUpload.mock.calls[0]![0] as SyncEnqueueUploadRequest;
    expect(call.sourcePath).toBe("/home/user/doc.pdf");
    expect(call.targetPath).toBe("/doc.pdf");
  });

  it("throws 'upload cancelled by user' and does NOT enqueue when the picker is canceled", async () => {
    const { syncClient, enqueueUpload } = makeSyncClient();
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: true,
      filePaths: [],
    });

    await expect(
      handler({ datasourceId: "ds-1" }, { showOpenDialog, syncClient }),
    ).rejects.toThrow(/upload cancell?ed by user/i);
    expect(enqueueUpload).not.toHaveBeenCalled();
  });

  it("throws and does NOT enqueue when the picker returns an empty selection", async () => {
    const { syncClient, enqueueUpload } = makeSyncClient();
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: [],
    });

    await expect(
      handler({ datasourceId: "ds-1" }, { showOpenDialog, syncClient }),
    ).rejects.toThrow(/upload cancell?ed by user/i);
    expect(enqueueUpload).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Source-level assertion — proves the 8.2 rewrite severed engine coupling.
  // -------------------------------------------------------------------------

  it("the handler module has zero @ft5/fs-datasource-engine coupling", () => {
    const uploadTsPath = path.resolve(__dirname, "../upload.ts");
    const src = readFileSync(uploadTsPath, "utf8");

    // A single combined pattern catches any of the forbidden couplings —
    // engine import, engine singleton accessor, credential store, factory
    // construction, or a direct provider uploadFile call. All five are
    // present in the pre-rewrite source; the 8.2 GREEN commit removes them.
    const forbidden =
      /@ft5\/fs-datasource-engine|getEngine\(\)|credentialStore|factory\.create|engine\.uploadFile/;
    expect(src).not.toMatch(forbidden);
  });

  // -------------------------------------------------------------------------
  // Renderer contract — the `DatasourcesUpload*` types stay flat.
  // This test is compile-time; the runtime assertion is a formality.
  // -------------------------------------------------------------------------

  it("preserves the DatasourcesUploadRequest / DatasourcesUploadResponse shape", () => {
    const req: DatasourcesUploadRequest = { datasourceId: "ds-1" };
    const res: DatasourcesUploadResponse = { transactionId: "tx-1" };
    expect(req.datasourceId).toBe("ds-1");
    expect(res.transactionId).toBe("tx-1");
  });
});
