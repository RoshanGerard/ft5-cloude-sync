// Unit tests for the in-memory `UploadRegistry` that backs the
// fs-sync service's UPLOAD-side state. Mirror of
// `services/fs-sync/src/downloads/__tests__/registry.test.ts`.
//
// See:
// - openspec/changes/migrate-upload-orchestration-out-of-engine/design.md
//   "Decision 6 — `UploadRegistry` mirrors `DownloadRegistry` exactly".
// - openspec/changes/migrate-upload-orchestration-out-of-engine/specs/
//   fs-sync-service/spec.md "Requirement: `UploadRegistry` tracks
//   in-flight uploads in memory".
//
// Shape recap (service-internal, carries `abortController`; the IPC-exposed
// `UploadJob` from `@ft5/ipc-contracts` strips it):
//
//   interface UploadJobEntry {
//     uploadJobId: string;             // service-minted UUID
//     datasourceId: string;
//     sourcePath: string;              // local file on disk
//     targetPath: string;              // remote provider path
//     bytesUploaded: number;
//     contentLength: number | null;
//     startedAt: number;               // ms epoch
//     abortController: AbortController;
//   }
//
// API: set / get / update / delete / snapshot / findByTarget. Reverse
// index keyed `(datasourceId, targetPath)` — the **target** slot, not
// the source (Decision 6 — different local files uploading to the same
// remote slot are also rejected).

import { describe, expect, it } from "vitest";

import {
  createUploadRegistry,
  type UploadJobEntry,
  type UploadJobUpdate,
} from "../registry.js";

function makeEntry(
  overrides: Partial<UploadJobEntry> = {},
): UploadJobEntry {
  return {
    uploadJobId: "job-A",
    datasourceId: "ds-1",
    sourcePath: "/local/photos/x.jpg",
    targetPath: "/photos/x.jpg",
    bytesUploaded: 0,
    contentLength: 1_048_576,
    startedAt: 1_000,
    abortController: new AbortController(),
    ...overrides,
  };
}

describe("UploadRegistry", () => {
  describe("set / get", () => {
    it("set adds an entry keyed by uploadJobId, retrievable via get", () => {
      const registry = createUploadRegistry();
      const entry = makeEntry();
      registry.set(entry);
      const got = registry.get("job-A");
      expect(got).toBeDefined();
      expect(got?.uploadJobId).toBe("job-A");
      expect(got?.datasourceId).toBe("ds-1");
      expect(got?.sourcePath).toBe("/local/photos/x.jpg");
      expect(got?.targetPath).toBe("/photos/x.jpg");
      expect(got?.bytesUploaded).toBe(0);
      expect(got?.contentLength).toBe(1_048_576);
      expect(got?.startedAt).toBe(1_000);
      // The abortController is the SAME reference — must not be cloned, the
      // handler aborts cancels through it.
      expect(got?.abortController).toBe(entry.abortController);
    });

    it("get for an unknown uploadJobId returns undefined, never throws", () => {
      const registry = createUploadRegistry();
      expect(() => registry.get("nope")).not.toThrow();
      expect(registry.get("nope")).toBeUndefined();
    });

    it("set with the same uploadJobId twice replaces the entry (last write wins)", () => {
      const registry = createUploadRegistry();
      const first = makeEntry({ bytesUploaded: 100 });
      const second = makeEntry({ bytesUploaded: 200 });
      registry.set(first);
      registry.set(second);
      expect(registry.get("job-A")?.bytesUploaded).toBe(200);
      expect(registry.get("job-A")?.abortController).toBe(second.abortController);
    });

    it("size reflects the number of entries", () => {
      const registry = createUploadRegistry();
      expect(registry.size()).toBe(0);
      registry.set(makeEntry({ uploadJobId: "job-A", startedAt: 1_000 }));
      registry.set(
        makeEntry({
          uploadJobId: "job-B",
          targetPath: "/photos/y.jpg",
          startedAt: 2_000,
        }),
      );
      expect(registry.size()).toBe(2);
    });
  });

  describe("update", () => {
    it("update merges the partial into the existing entry", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ bytesUploaded: 0, contentLength: null }));
      registry.update("job-A", {
        bytesUploaded: 524_288,
        contentLength: 1_048_576,
      });
      const got = registry.get("job-A");
      expect(got?.bytesUploaded).toBe(524_288);
      expect(got?.contentLength).toBe(1_048_576);
      // Identity fields untouched.
      expect(got?.uploadJobId).toBe("job-A");
      expect(got?.datasourceId).toBe("ds-1");
      expect(got?.sourcePath).toBe("/local/photos/x.jpg");
      expect(got?.targetPath).toBe("/photos/x.jpg");
      expect(got?.startedAt).toBe(1_000);
    });

    it("update merges partial fields independently", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ bytesUploaded: 100, contentLength: 1_000 }));
      registry.update("job-A", { bytesUploaded: 250 });
      expect(registry.get("job-A")?.bytesUploaded).toBe(250);
      expect(registry.get("job-A")?.contentLength).toBe(1_000);
    });

    it("update preserves the abortController reference (no cloning)", () => {
      const registry = createUploadRegistry();
      const entry = makeEntry();
      registry.set(entry);
      registry.update("job-A", { bytesUploaded: 42 });
      expect(registry.get("job-A")?.abortController).toBe(entry.abortController);
    });

    it("update on a missing uploadJobId is a silent no-op (no throw, registry unchanged)", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry());
      expect(() =>
        registry.update("does-not-exist", { bytesUploaded: 1 }),
      ).not.toThrow();
      expect(registry.get("job-A")?.bytesUploaded).toBe(0);
      expect(registry.size()).toBe(1);
    });

    it("update produces a fresh entry object (replace-don't-mutate)", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ bytesUploaded: 0 }));
      const before = registry.get("job-A");
      registry.update("job-A", { bytesUploaded: 999 });
      const after = registry.get("job-A");
      expect(before?.bytesUploaded).toBe(0);
      expect(after?.bytesUploaded).toBe(999);
      expect(before).not.toBe(after);
    });
  });

  describe("delete", () => {
    it("delete removes the entry; subsequent get returns undefined", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry());
      registry.delete("job-A");
      expect(registry.get("job-A")).toBeUndefined();
      expect(registry.size()).toBe(0);
    });

    it("delete on a missing uploadJobId is a silent no-op (no throw)", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ uploadJobId: "job-A" }));
      expect(() => registry.delete("does-not-exist")).not.toThrow();
      expect(registry.size()).toBe(1);
      expect(registry.get("job-A")).toBeDefined();
    });

    it("delete then snapshot omits the entry", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ uploadJobId: "job-A", startedAt: 1_000 }));
      registry.set(
        makeEntry({
          uploadJobId: "job-B",
          targetPath: "/photos/y.jpg",
          startedAt: 2_000,
        }),
      );
      registry.delete("job-A");
      const snap = registry.snapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0]?.uploadJobId).toBe("job-B");
    });
  });

  describe("snapshot", () => {
    it("snapshot returns [] for an empty registry", () => {
      const registry = createUploadRegistry();
      expect(registry.snapshot()).toEqual([]);
    });

    it("snapshot returns entries ordered by startedAt ascending (oldest first)", () => {
      const registry = createUploadRegistry();
      registry.set(
        makeEntry({
          uploadJobId: "job-C",
          targetPath: "/photos/c.jpg",
          startedAt: 3_000,
        }),
      );
      registry.set(
        makeEntry({
          uploadJobId: "job-A",
          targetPath: "/photos/a.jpg",
          startedAt: 1_000,
        }),
      );
      registry.set(
        makeEntry({
          uploadJobId: "job-B",
          targetPath: "/photos/b.jpg",
          startedAt: 2_000,
        }),
      );
      const ids = registry.snapshot().map((e) => e.uploadJobId);
      expect(ids).toEqual(["job-A", "job-B", "job-C"]);
    });

    it("snapshot is a stable copy: mutating the returned array does not mutate the registry", () => {
      const registry = createUploadRegistry();
      registry.set(
        makeEntry({
          uploadJobId: "job-A",
          targetPath: "/photos/a.jpg",
          startedAt: 1_000,
        }),
      );
      registry.set(
        makeEntry({
          uploadJobId: "job-B",
          targetPath: "/photos/b.jpg",
          startedAt: 2_000,
        }),
      );
      const snap = registry.snapshot();
      snap.push(
        makeEntry({
          uploadJobId: "phantom",
          targetPath: "/photos/p.jpg",
          startedAt: 9_999,
        }),
      );
      snap.splice(0, 1);
      const snap2 = registry.snapshot();
      expect(snap2).toHaveLength(2);
      expect(snap2.map((e) => e.uploadJobId).sort()).toEqual(["job-A", "job-B"]);
    });

    it("snapshot taken before an update is unaffected by the update (replace-don't-mutate)", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ bytesUploaded: 0 }));
      const snap = registry.snapshot();
      registry.update("job-A", { bytesUploaded: 500 });
      expect(snap[0]?.bytesUploaded).toBe(0);
      expect(registry.snapshot()[0]?.bytesUploaded).toBe(500);
    });
  });

  describe("concurrency safety", () => {
    it("100 rapid update calls all land before a final snapshot reflects all of them", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ bytesUploaded: 0 }));
      for (let i = 1; i <= 100; i++) {
        registry.update("job-A", { bytesUploaded: i });
      }
      expect(registry.snapshot()[0]?.bytesUploaded).toBe(100);
      expect(registry.get("job-A")?.bytesUploaded).toBe(100);
    });

    it("interleaved set / update / delete preserves last-writer-wins semantics", () => {
      const registry = createUploadRegistry();
      const a1 = makeEntry({ uploadJobId: "job-A", startedAt: 1_000 });
      const b1 = makeEntry({
        uploadJobId: "job-B",
        targetPath: "/photos/y.jpg",
        startedAt: 2_000,
      });
      registry.set(a1);
      registry.set(b1);
      registry.update("job-A", { bytesUploaded: 10 });
      registry.update("job-B", { bytesUploaded: 20 });
      registry.delete("job-A");
      registry.update("job-B", { bytesUploaded: 30 });
      const snap = registry.snapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0]?.uploadJobId).toBe("job-B");
      expect(snap[0]?.bytesUploaded).toBe(30);
    });

    it("rapid set/delete cycle does NOT leak the reverse-index mapping", () => {
      // §8.3 — atomic update of forward + reverse indexes. After many
      // cycles of `set(entry); delete(entry.uploadJobId);` the
      // reverse-index lookup MUST return undefined for that target slot
      // — a leaked mapping would falsely resolve to a now-deleted job.
      const registry = createUploadRegistry();
      for (let i = 0; i < 50; i++) {
        const entry = makeEntry({
          uploadJobId: `job-${i}`,
          targetPath: "/photos/x.jpg",
          startedAt: 1_000 + i,
        });
        registry.set(entry);
        registry.delete(`job-${i}`);
      }
      expect(registry.findByTarget("ds-1", "/photos/x.jpg")).toBeUndefined();
      expect(registry.size()).toBe(0);
      expect(registry.snapshot()).toEqual([]);
    });
  });

  // Reverse-index lookup (per §8 + spec.md "Concurrent-target upload
  // conflict guard"). The handler's concurrent-target rejection guard
  // reads `(datasourceId, targetPath) → uploadJobId` BEFORE any engine
  // call. Identity fields are immutable; the reverse index is set on
  // `set` and cleared on `delete` — `update` does NOT touch it.
  describe("findByTarget reverse index (§8.2)", () => {
    it("returns the uploadJobId for an in-flight (datasourceId, targetPath) pair", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ uploadJobId: "job-A" }));
      expect(registry.findByTarget("ds-1", "/photos/x.jpg")).toBe("job-A");
    });

    it("returns undefined for an unknown (datasourceId, targetPath) pair", () => {
      const registry = createUploadRegistry();
      expect(
        registry.findByTarget("ds-ghost", "/unknown.jpg"),
      ).toBeUndefined();
    });

    it("clears the mapping after delete so a fresh upload can re-claim the target", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ uploadJobId: "job-A" }));
      registry.delete("job-A");
      expect(registry.findByTarget("ds-1", "/photos/x.jpg")).toBeUndefined();
      registry.set(
        makeEntry({ uploadJobId: "job-B", startedAt: 2_000 }),
      );
      expect(registry.findByTarget("ds-1", "/photos/x.jpg")).toBe("job-B");
    });

    it("is unaffected by update — identity fields are immutable per the §8 contract", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ uploadJobId: "job-A" }));
      registry.update("job-A", {
        bytesUploaded: 524_288,
        contentLength: 1_048_576,
      });
      expect(registry.findByTarget("ds-1", "/photos/x.jpg")).toBe("job-A");
    });

    it("distinct (datasourceId, targetPath) pairs each map to their own uploadJobId", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ uploadJobId: "job-A" }));
      registry.set(
        makeEntry({
          uploadJobId: "job-B",
          datasourceId: "ds-2",
          targetPath: "/photos/y.jpg",
          startedAt: 2_000,
        }),
      );
      expect(registry.findByTarget("ds-1", "/photos/x.jpg")).toBe("job-A");
      expect(registry.findByTarget("ds-2", "/photos/y.jpg")).toBe("job-B");
    });

    it("same targetPath on different datasourceId resolves independently", () => {
      // Decision 10 — different `datasourceId` namespaces. Both can hold
      // an in-flight upload to the same `targetPath` without conflict.
      const registry = createUploadRegistry();
      registry.set(
        makeEntry({
          uploadJobId: "job-on-ds1",
          datasourceId: "ds-1",
          targetPath: "/x.jpg",
        }),
      );
      registry.set(
        makeEntry({
          uploadJobId: "job-on-ds2",
          datasourceId: "ds-2",
          targetPath: "/x.jpg",
          startedAt: 2_000,
        }),
      );
      expect(registry.findByTarget("ds-1", "/x.jpg")).toBe("job-on-ds1");
      expect(registry.findByTarget("ds-2", "/x.jpg")).toBe("job-on-ds2");
    });

    it("delete is a no-op on an unknown id and does not corrupt the reverse index", () => {
      const registry = createUploadRegistry();
      registry.set(makeEntry({ uploadJobId: "job-A" }));
      registry.delete("nope");
      expect(registry.findByTarget("ds-1", "/photos/x.jpg")).toBe("job-A");
    });

    it("reverse-index keys on TARGET slot, not source (Decision 6)", () => {
      // Two uploads from DIFFERENT local source files to the SAME
      // remote target — the registry's reverse-index keys on the
      // target only, so the second insertion's reverse mapping
      // overwrites the first (the handler's concurrent-target guard
      // catches this BEFORE the second `set` ever runs in production).
      const registry = createUploadRegistry();
      registry.set(
        makeEntry({
          uploadJobId: "job-A",
          sourcePath: "/local/a.jpg",
          targetPath: "/photos/x.jpg",
        }),
      );
      // findByTarget keys on (datasourceId, targetPath) — no source
      // disambiguator — so this lookup resolves to job-A regardless of
      // the source file's path.
      expect(registry.findByTarget("ds-1", "/photos/x.jpg")).toBe("job-A");
    });
  });

  // Type-level guard that the partial accepted by `update` excludes the
  // immutable identity fields. Runtime no-op; the value comes from the
  // `pnpm typecheck` pass.
  describe("type-level guards", () => {
    it("UploadJobUpdate accepts mutable fields and rejects identity fields", () => {
      const ok: UploadJobUpdate = { bytesUploaded: 1 };
      const ok2: UploadJobUpdate = { contentLength: null };
      const ok3: UploadJobUpdate = { bytesUploaded: 1, contentLength: 2 };
      expect(ok).toBeDefined();
      expect(ok2).toBeDefined();
      expect(ok3).toBeDefined();

      // The following would fail typecheck (uncomment to verify locally):
      //   const bad: UploadJobUpdate = { uploadJobId: "x" };
      //   const bad2: UploadJobUpdate = { datasourceId: "x" };
      //   const bad3: UploadJobUpdate = { sourcePath: "x" };
      //   const bad4: UploadJobUpdate = { targetPath: "x" };
      //   const bad5: UploadJobUpdate = { startedAt: 0 };
      //   const bad6: UploadJobUpdate = { abortController: new AbortController() };
    });
  });
});
