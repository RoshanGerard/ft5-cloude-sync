// add-download-resilience §12.6 (iter-5, Decision 16) — handleSyncCancelDownload
//
// Near-identity proxy over `SyncClient.cancelDownload`. Mirrors the
// `cancel-job.test.ts` scaffold but asserts the iter-5 contract: flat
// `{ cancelled: boolean }` response (NOT a fallible union — the service
// handler is idempotent), no `not-cancelable` shape catch.

import { describe, expect, it, vi } from "vitest";

import type { SyncCancelDownloadRequest } from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../../sync/client.js";
import { handleSyncCancelDownload } from "../cancel-download.js";

function makeFakeClient(
  impl: (params: SyncCancelDownloadRequest) => Promise<unknown>,
): { client: SyncClient; cancelDownload: ReturnType<typeof vi.fn> } {
  const cancelDownload = vi.fn(impl);
  const client = { cancelDownload } as unknown as SyncClient;
  return { client, cancelDownload };
}

describe("handleSyncCancelDownload", () => {
  it("proxies to client.cancelDownload with the wire params and returns { cancelled: true } verbatim", async () => {
    const { client, cancelDownload } = makeFakeClient(async () => ({
      cancelled: true,
    }));
    const req: SyncCancelDownloadRequest = { downloadJobId: "d-1" };

    const res = await handleSyncCancelDownload(req, client);

    expect(cancelDownload).toHaveBeenCalledTimes(1);
    expect(cancelDownload).toHaveBeenCalledWith({ downloadJobId: "d-1" });
    expect(res).toEqual({ cancelled: true });
  });

  it("returns { cancelled: false } verbatim for an unknown downloadJobId (idempotent)", async () => {
    // Service-side `sync:cancel-download` is idempotent: cancel of an
    // unknown job resolves with `{ cancelled: false }` (services/fs-sync/
    // src/commands/files-download.ts makeSyncCancelDownloadHandler).
    // The desktop proxy passes that through verbatim — no error envelope.
    const { client, cancelDownload } = makeFakeClient(async () => ({
      cancelled: false,
    }));

    const res = await handleSyncCancelDownload(
      { downloadJobId: "d-missing" },
      client,
    );

    expect(cancelDownload).toHaveBeenCalledTimes(1);
    expect(cancelDownload).toHaveBeenCalledWith({
      downloadJobId: "d-missing",
    });
    expect(res).toEqual({ cancelled: false });
  });

  it("re-throws underlying client errors (e.g. service-disconnected) — no fallible shape to catch", async () => {
    // No `not-cancelable` shape exists for cancel-download (the service
    // handler is idempotent — never errors on unknown jobIds). Any
    // thrown error means a transport-level failure (service-disconnected,
    // malformed request, etc.) which must surface to the renderer as an
    // IPC invoke rejection.
    const err = new Error("service-disconnected");
    const { client } = makeFakeClient(async () => {
      throw err;
    });

    await expect(
      handleSyncCancelDownload({ downloadJobId: "d-1" }, client),
    ).rejects.toBe(err);
  });
});
