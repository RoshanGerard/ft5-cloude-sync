// migrate-upload-orchestration-out-of-engine §13.2 — handleSyncCancelUpload
//
// Near-identity proxy over `SyncClient.cancelUpload`. Mirrors the
// `cancel-download.test.ts` scaffold: idempotent service-side handler →
// flat `{ cancelled: boolean }` response (NOT a fallible union); transport
// failures re-throw so the IPC layer surfaces them as renderer-side
// invoke rejections.

import { describe, expect, it, vi } from "vitest";

import type { SyncCancelUploadRequest } from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { handleSyncCancelUpload } from "../cancel-upload.js";

function makeFakeClient(
  impl: (params: SyncCancelUploadRequest) => Promise<unknown>,
): { client: SyncClient; cancelUpload: ReturnType<typeof vi.fn> } {
  const cancelUpload = vi.fn(impl);
  const client = { cancelUpload } as unknown as SyncClient;
  return { client, cancelUpload };
}

describe("handleSyncCancelUpload", () => {
  it("proxies to client.cancelUpload with the wire params and returns { cancelled: true } verbatim", async () => {
    const { client, cancelUpload } = makeFakeClient(async () => ({
      cancelled: true,
    }));
    const req: SyncCancelUploadRequest = { uploadJobId: "u-1" };

    const res = await handleSyncCancelUpload(req, client);

    expect(cancelUpload).toHaveBeenCalledTimes(1);
    expect(cancelUpload).toHaveBeenCalledWith({ uploadJobId: "u-1" });
    expect(res).toEqual({ cancelled: true });
  });

  it("returns { cancelled: false } verbatim for an unknown uploadJobId (idempotent)", async () => {
    // Service-side `sync:cancel-upload` is idempotent: cancel of an
    // unknown job resolves with `{ cancelled: false }` (see
    // services/fs-sync/src/commands/sync-cancel-upload.ts). The desktop
    // proxy passes that through verbatim — no error envelope.
    const { client, cancelUpload } = makeFakeClient(async () => ({
      cancelled: false,
    }));

    const res = await handleSyncCancelUpload(
      { uploadJobId: "u-missing" },
      client,
    );

    expect(cancelUpload).toHaveBeenCalledTimes(1);
    expect(cancelUpload).toHaveBeenCalledWith({
      uploadJobId: "u-missing",
    });
    expect(res).toEqual({ cancelled: false });
  });

  it("re-throws underlying client errors (e.g. service-disconnected) — no fallible shape to catch", async () => {
    // No fallible shape exists for cancel-upload (the service handler is
    // idempotent — never errors on unknown uploadJobIds). Any thrown
    // error means a transport-level failure (service-disconnected,
    // malformed request, etc.) which must surface to the renderer as an
    // IPC invoke rejection.
    const err = new Error("service-disconnected");
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncCancelUpload({ uploadJobId: "u-1" }, client),
    ).rejects.toBe(err);
  });
});
