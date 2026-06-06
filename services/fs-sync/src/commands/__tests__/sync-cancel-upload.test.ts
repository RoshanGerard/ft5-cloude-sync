// Unit tests for the `sync:cancel-upload` RPC handler — looks up the
// in-flight `UploadJobEntry` by `uploadJobId` and aborts its
// AbortController. Idempotent on unknown ids. Per
// migrate-upload-orchestration-out-of-engine §10.2 / §10.5. Mirror of
// `sync:cancel-download`.

import { describe, expect, it } from "vitest";

import { createUploadRegistry } from "../../uploads/registry.js";
import { makeSyncCancelUploadHandler } from "../sync-cancel-upload.js";

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

function makeEntry(id: string, ac: AbortController) {
  return {
    uploadJobId: id,
    datasourceId: "ds-1",
    sourcePath: "/local/a.jpg",
    targetPath: "/photos/a.jpg",
    bytesUploaded: 0,
    contentLength: 1024,
    startedAt: 1000,
    abortController: ac,
  };
}

describe("sync:cancel-upload handler — §10.2 (unit)", () => {
  it("known uploadJobId: aborts the controller and replies { cancelled: true }", async () => {
    const registry = createUploadRegistry();
    const ac = new AbortController();
    registry.set(makeEntry("job-A", ac));
    const handler = makeSyncCancelUploadHandler({ registry });

    expect(ac.signal.aborted).toBe(false);
    const result = await handler({ uploadJobId: "job-A" }, ctx);

    expect(result).toEqual({ ok: true, result: { cancelled: true } });
    expect(ac.signal.aborted).toBe(true);
  });

  it("unknown uploadJobId: replies { cancelled: false }, idempotent (no throw)", async () => {
    const registry = createUploadRegistry();
    const handler = makeSyncCancelUploadHandler({ registry });

    const result = await handler({ uploadJobId: "tx-does-not-exist" }, ctx);

    expect(result).toEqual({ ok: true, result: { cancelled: false } });
  });

  it("idempotent on repeat cancel: first call cancelled: true, second call (entry still in registry) also cancelled: true", async () => {
    // Per the spec scenario: "cancel-upload is idempotent — invoked
    // twice in rapid succession, the first response is { cancelled:
    // true }; the second response is { cancelled: true } if the entry
    // is still present (handler's catch hasn't run yet) or { cancelled:
    // false } if it has been deleted." The handler does NOT delete the
    // registry entry — that's the `files:upload` handler's job in its
    // catch path. So a synchronous second-call sees the same entry
    // and returns cancelled: true again.
    const registry = createUploadRegistry();
    const ac = new AbortController();
    registry.set(makeEntry("job-A", ac));
    const handler = makeSyncCancelUploadHandler({ registry });

    const r1 = await handler({ uploadJobId: "job-A" }, ctx);
    const r2 = await handler({ uploadJobId: "job-A" }, ctx);

    expect(r1).toEqual({ ok: true, result: { cancelled: true } });
    expect(r2).toEqual({ ok: true, result: { cancelled: true } });
    // Signal stays aborted (calling .abort() again is a no-op).
    expect(ac.signal.aborted).toBe(true);
  });

  it("does NOT delete the registry entry (the upload handler's catch owns deletion)", async () => {
    // Per spec.md "Requirement: `sync:cancel-upload` RPC" → "The cancel
    // SHALL NOT directly delete the registry entry; the entry deletion
    // happens in the `files:upload` handler's catch path when the
    // engine call rejects with `tag: 'cancelled'`."
    const registry = createUploadRegistry();
    const ac = new AbortController();
    registry.set(makeEntry("job-A", ac));
    const handler = makeSyncCancelUploadHandler({ registry });

    await handler({ uploadJobId: "job-A" }, ctx);

    expect(registry.size()).toBe(1);
    expect(registry.get("job-A")).toBeDefined();
  });

  it("cancels only the requested entry, leaves siblings untouched", async () => {
    const registry = createUploadRegistry();
    const acA = new AbortController();
    const acB = new AbortController();
    registry.set(makeEntry("job-A", acA));
    registry.set({
      uploadJobId: "job-B",
      datasourceId: "ds-1",
      sourcePath: "/local/b.jpg",
      targetPath: "/photos/b.jpg",
      bytesUploaded: 0,
      contentLength: 2048,
      startedAt: 2000,
      abortController: acB,
    });
    const handler = makeSyncCancelUploadHandler({ registry });

    await handler({ uploadJobId: "job-A" }, ctx);

    expect(acA.signal.aborted).toBe(true);
    expect(acB.signal.aborted).toBe(false);
  });
});
