// Unit tests for the `uploads:list-active` RPC handler — projects the
// in-memory `UploadRegistry` snapshot (internal `UploadJobEntry`,
// which carries an `AbortController`) to the IPC-exposed `UploadJob`
// shape (no controller). Per migrate-upload-orchestration-out-of-engine
// §10.1 / §10.4. Mirror of `downloads-list-active.test.ts`.

import { describe, expect, it } from "vitest";

import { createUploadRegistry } from "../../uploads/registry.js";
import { makeUploadsListActiveHandler } from "../uploads-list-active.js";

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

describe("uploads:list-active handler — §10.1 (unit)", () => {
  it("empty registry: returns { ok: true, result: { jobs: [] } }", async () => {
    const registry = createUploadRegistry();
    const handler = makeUploadsListActiveHandler({ registry });

    const result = await handler({}, ctx);

    expect(result).toEqual({ ok: true, result: { jobs: [] } });
  });

  it("returns the snapshot ordered by startedAt ascending — even when entries were inserted in reverse order", async () => {
    const registry = createUploadRegistry();
    // Insert the LATER job first; the registry's `snapshot()` orders by
    // `startedAt`, so the handler MUST surface them oldest-first.
    registry.set({
      uploadJobId: "job-newer",
      datasourceId: "ds-1",
      sourcePath: "/local/b.jpg",
      targetPath: "/photos/b.jpg",
      bytesUploaded: 50,
      contentLength: 200,
      startedAt: 2000,
      abortController: new AbortController(),
    });
    registry.set({
      uploadJobId: "job-older",
      datasourceId: "ds-1",
      sourcePath: "/local/a.jpg",
      targetPath: "/photos/a.jpg",
      bytesUploaded: 10,
      contentLength: 100,
      startedAt: 1000,
      abortController: new AbortController(),
    });
    const handler = makeUploadsListActiveHandler({ registry });

    const result = await handler({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.jobs.map((j) => j.uploadJobId)).toEqual([
      "job-older",
      "job-newer",
    ]);
    expect(result.result.jobs.map((j) => j.startedAt)).toEqual([1000, 2000]);
  });

  it("strips `abortController` from every entry — the IPC-exposed UploadJob shape never carries the controller", async () => {
    const registry = createUploadRegistry();
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    registry.set({
      uploadJobId: "j1",
      datasourceId: "ds-1",
      sourcePath: "/local/a.jpg",
      targetPath: "/photos/a.jpg",
      bytesUploaded: 10,
      contentLength: 100,
      startedAt: 1000,
      abortController: ac1,
    });
    registry.set({
      uploadJobId: "j2",
      datasourceId: "ds-2",
      sourcePath: "/local/b.jpg",
      targetPath: "/photos/b.jpg",
      bytesUploaded: 20,
      contentLength: 200,
      startedAt: 2000,
      abortController: ac2,
    });
    const handler = makeUploadsListActiveHandler({ registry });

    const result = await handler({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const job of result.result.jobs) {
      // Property-level absence — `toEqual` would silently pass with
      // `abortController: undefined`. Assert the key is not on the
      // object at all so the wire shape is clean.
      expect(
        Object.prototype.hasOwnProperty.call(job, "abortController"),
      ).toBe(false);
    }
    expect(result.result.jobs[0]).toEqual({
      uploadJobId: "j1",
      datasourceId: "ds-1",
      sourcePath: "/local/a.jpg",
      targetPath: "/photos/a.jpg",
      bytesUploaded: 10,
      contentLength: 100,
      startedAt: 1000,
    });
    expect(result.result.jobs[1]).toEqual({
      uploadJobId: "j2",
      datasourceId: "ds-2",
      sourcePath: "/local/b.jpg",
      targetPath: "/photos/b.jpg",
      bytesUploaded: 20,
      contentLength: 200,
      startedAt: 2000,
    });
  });

  it("preserves null contentLength (provider has not advertised total) verbatim", async () => {
    const registry = createUploadRegistry();
    registry.set({
      uploadJobId: "j-indeterminate",
      datasourceId: "ds-1",
      sourcePath: "/local/streaming.bin",
      targetPath: "/uploads/streaming.bin",
      bytesUploaded: 1234,
      contentLength: null,
      startedAt: 500,
      abortController: new AbortController(),
    });
    const handler = makeUploadsListActiveHandler({ registry });

    const result = await handler({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.jobs).toHaveLength(1);
    expect(result.result.jobs[0]?.contentLength).toBeNull();
  });
});
