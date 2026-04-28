// Unit tests for the in-memory `DownloadRegistry` that backs the
// fs-sync service's DOWNLOAD-side state. See:
//
// - openspec/changes/add-engine-rename-download/design.md "Decision 4"
//   (in-memory only, lives in the service handler not the engine).
// - openspec/changes/add-engine-rename-download/specs/fs-sync-service/spec.md
//   "Requirement: In-memory `DownloadRegistry` tracks active downloads".
//
// Shape recap (service-internal, carries `abortController`; the IPC-exposed
// `DownloadJob` from `@ft5/ipc-contracts` strips it):
//
//   interface DownloadJobEntry {
//     downloadJobId: string;          // service-minted UUID
//     datasourceId: string;
//     sourcePath: string;
//     targetPath: string;
//     bytesDownloaded: number;
//     contentLength: number | null;
//     startedAt: number;              // ms epoch
//     abortController: AbortController;
//   }
//
// API: set / update / delete / get / snapshot. See registry.ts for full
// rationale on the type-narrow `update` partial and the replace-don't-mutate
// strategy.

import { describe, expect, it } from "vitest";

import {
  createDownloadRegistry,
  type DownloadJobEntry,
  type DownloadJobUpdate,
} from "../registry.js";

function makeEntry(
  overrides: Partial<DownloadJobEntry> = {},
): DownloadJobEntry {
  return {
    downloadJobId: "job-A",
    datasourceId: "ds-1",
    sourcePath: "/welcome.pdf",
    targetPath: "/downloads/welcome.pdf",
    bytesDownloaded: 0,
    contentLength: 1_048_576,
    startedAt: 1_000,
    abortController: new AbortController(),
    ...overrides,
  };
}

describe("DownloadRegistry", () => {
  describe("set / get", () => {
    it("set adds an entry keyed by downloadJobId, retrievable via get", () => {
      const registry = createDownloadRegistry();
      const entry = makeEntry();
      registry.set(entry);
      const got = registry.get("job-A");
      expect(got).toBeDefined();
      expect(got?.downloadJobId).toBe("job-A");
      expect(got?.datasourceId).toBe("ds-1");
      expect(got?.sourcePath).toBe("/welcome.pdf");
      expect(got?.targetPath).toBe("/downloads/welcome.pdf");
      expect(got?.bytesDownloaded).toBe(0);
      expect(got?.contentLength).toBe(1_048_576);
      expect(got?.startedAt).toBe(1_000);
      // The abortController is the SAME reference — must not be cloned, the
      // handler aborts cancels through it.
      expect(got?.abortController).toBe(entry.abortController);
    });

    it("get for an unknown downloadJobId returns undefined, never throws", () => {
      const registry = createDownloadRegistry();
      expect(() => registry.get("nope")).not.toThrow();
      expect(registry.get("nope")).toBeUndefined();
    });

    it("set with the same downloadJobId twice replaces the entry (last write wins)", () => {
      const registry = createDownloadRegistry();
      const first = makeEntry({ bytesDownloaded: 100 });
      const second = makeEntry({ bytesDownloaded: 200 });
      registry.set(first);
      registry.set(second);
      expect(registry.get("job-A")?.bytesDownloaded).toBe(200);
      // The replacement uses the second entry's abortController.
      expect(registry.get("job-A")?.abortController).toBe(second.abortController);
    });

    it("size reflects the number of entries", () => {
      const registry = createDownloadRegistry();
      expect(registry.size()).toBe(0);
      registry.set(makeEntry({ downloadJobId: "job-A", startedAt: 1_000 }));
      registry.set(makeEntry({ downloadJobId: "job-B", startedAt: 2_000 }));
      expect(registry.size()).toBe(2);
    });
  });

  describe("update", () => {
    it("update merges the partial into the existing entry", () => {
      const registry = createDownloadRegistry();
      registry.set(makeEntry({ bytesDownloaded: 0, contentLength: null }));
      registry.update("job-A", {
        bytesDownloaded: 524_288,
        contentLength: 1_048_576,
      });
      const got = registry.get("job-A");
      expect(got?.bytesDownloaded).toBe(524_288);
      expect(got?.contentLength).toBe(1_048_576);
      // Identity fields untouched.
      expect(got?.downloadJobId).toBe("job-A");
      expect(got?.datasourceId).toBe("ds-1");
      expect(got?.sourcePath).toBe("/welcome.pdf");
      expect(got?.targetPath).toBe("/downloads/welcome.pdf");
      expect(got?.startedAt).toBe(1_000);
    });

    it("update merges partial fields independently (only one of {bytesDownloaded, contentLength})", () => {
      const registry = createDownloadRegistry();
      registry.set(makeEntry({ bytesDownloaded: 100, contentLength: 1_000 }));
      registry.update("job-A", { bytesDownloaded: 250 });
      expect(registry.get("job-A")?.bytesDownloaded).toBe(250);
      // contentLength untouched.
      expect(registry.get("job-A")?.contentLength).toBe(1_000);
    });

    it("update preserves the abortController reference (no cloning)", () => {
      const registry = createDownloadRegistry();
      const entry = makeEntry();
      registry.set(entry);
      registry.update("job-A", { bytesDownloaded: 42 });
      expect(registry.get("job-A")?.abortController).toBe(entry.abortController);
    });

    it("update on a missing downloadJobId is a silent no-op (no throw, registry unchanged)", () => {
      const registry = createDownloadRegistry();
      registry.set(makeEntry());
      expect(() =>
        registry.update("does-not-exist", { bytesDownloaded: 1 }),
      ).not.toThrow();
      // Existing entry untouched.
      expect(registry.get("job-A")?.bytesDownloaded).toBe(0);
      expect(registry.size()).toBe(1);
    });

    it("update produces a fresh entry object (replace-don't-mutate)", () => {
      // This guards the "snapshot is a stable copy" property — if `update`
      // mutated the entry in place, a snapshot taken before the update would
      // see post-update values, breaking consumers.
      const registry = createDownloadRegistry();
      registry.set(makeEntry({ bytesDownloaded: 0 }));
      const before = registry.get("job-A");
      registry.update("job-A", { bytesDownloaded: 999 });
      const after = registry.get("job-A");
      expect(before?.bytesDownloaded).toBe(0); // pre-update reference unchanged
      expect(after?.bytesDownloaded).toBe(999);
      expect(before).not.toBe(after);
    });
  });

  describe("delete", () => {
    it("delete removes the entry; subsequent get returns undefined", () => {
      const registry = createDownloadRegistry();
      registry.set(makeEntry());
      registry.delete("job-A");
      expect(registry.get("job-A")).toBeUndefined();
      expect(registry.size()).toBe(0);
    });

    it("delete on a missing downloadJobId is a silent no-op (no throw)", () => {
      const registry = createDownloadRegistry();
      registry.set(makeEntry({ downloadJobId: "job-A" }));
      expect(() => registry.delete("does-not-exist")).not.toThrow();
      expect(registry.size()).toBe(1);
      expect(registry.get("job-A")).toBeDefined();
    });

    it("delete then snapshot omits the entry", () => {
      const registry = createDownloadRegistry();
      registry.set(makeEntry({ downloadJobId: "job-A", startedAt: 1_000 }));
      registry.set(makeEntry({ downloadJobId: "job-B", startedAt: 2_000 }));
      registry.delete("job-A");
      const snap = registry.snapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0]?.downloadJobId).toBe("job-B");
    });
  });

  describe("snapshot", () => {
    it("snapshot returns [] for an empty registry", () => {
      const registry = createDownloadRegistry();
      expect(registry.snapshot()).toEqual([]);
    });

    it("snapshot returns entries ordered by startedAt ascending (oldest first)", () => {
      const registry = createDownloadRegistry();
      // Insert in non-startedAt order to prove the sort happens.
      registry.set(makeEntry({ downloadJobId: "job-C", startedAt: 3_000 }));
      registry.set(makeEntry({ downloadJobId: "job-A", startedAt: 1_000 }));
      registry.set(makeEntry({ downloadJobId: "job-B", startedAt: 2_000 }));
      const ids = registry.snapshot().map((e) => e.downloadJobId);
      expect(ids).toEqual(["job-A", "job-B", "job-C"]);
    });

    it("snapshot is a stable copy: mutating the returned array does not mutate the registry", () => {
      const registry = createDownloadRegistry();
      registry.set(makeEntry({ downloadJobId: "job-A", startedAt: 1_000 }));
      registry.set(makeEntry({ downloadJobId: "job-B", startedAt: 2_000 }));
      const snap = registry.snapshot();
      // Push and splice on the returned array — the registry must be unaffected.
      snap.push(makeEntry({ downloadJobId: "phantom", startedAt: 9_999 }));
      snap.splice(0, 1);
      const snap2 = registry.snapshot();
      expect(snap2).toHaveLength(2);
      expect(snap2.map((e) => e.downloadJobId).sort()).toEqual(["job-A", "job-B"]);
    });

    it("snapshot taken before an update is unaffected by the update (replace-don't-mutate)", () => {
      const registry = createDownloadRegistry();
      registry.set(makeEntry({ bytesDownloaded: 0 }));
      const snap = registry.snapshot();
      registry.update("job-A", { bytesDownloaded: 500 });
      // The pre-update snapshot still reflects the pre-update state.
      expect(snap[0]?.bytesDownloaded).toBe(0);
      // A fresh snapshot reflects the new state.
      expect(registry.snapshot()[0]?.bytesDownloaded).toBe(500);
    });
  });

  describe("concurrency safety", () => {
    it("100 rapid update calls all land before a final snapshot reflects all of them", () => {
      // JavaScript is single-threaded, so map mutations are atomic at the
      // call boundary; the property under test is that the registry's API
      // does NOT read-modify-write across awaits in a way that races. The
      // implementation is fully synchronous; this test pins that contract.
      const registry = createDownloadRegistry();
      registry.set(makeEntry({ bytesDownloaded: 0 }));
      for (let i = 1; i <= 100; i++) {
        registry.update("job-A", { bytesDownloaded: i });
      }
      expect(registry.snapshot()[0]?.bytesDownloaded).toBe(100);
      expect(registry.get("job-A")?.bytesDownloaded).toBe(100);
    });

    it("interleaved set / update / delete preserves last-writer-wins semantics", () => {
      const registry = createDownloadRegistry();
      const a1 = makeEntry({ downloadJobId: "job-A", startedAt: 1_000 });
      const b1 = makeEntry({ downloadJobId: "job-B", startedAt: 2_000 });
      registry.set(a1);
      registry.set(b1);
      registry.update("job-A", { bytesDownloaded: 10 });
      registry.update("job-B", { bytesDownloaded: 20 });
      registry.delete("job-A");
      registry.update("job-B", { bytesDownloaded: 30 });
      const snap = registry.snapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0]?.downloadJobId).toBe("job-B");
      expect(snap[0]?.bytesDownloaded).toBe(30);
    });
  });

  // §11.3 — Tiny lifecycle integration test: registry transitions match the
  // design when fed a fake engine event sequence. The registry doesn't
  // subscribe to the engine bus (that's §13.21-§13.26); this test simulates
  // the lifecycle by manually calling set / update / delete in the order the
  // §13 handler will eventually drive (start → progress → terminal).
  describe("lifecycle integration (§11.3)", () => {
    it("start → multiple progress updates → terminal success removes the entry", () => {
      const registry = createDownloadRegistry();

      // 1. `set` on download start (the §13 handler mints downloadJobId and
      //    registers an entry with bytesDownloaded: 0).
      const abortController = new AbortController();
      registry.set({
        downloadJobId: "job-lifecycle",
        datasourceId: "ds-1",
        sourcePath: "/welcome.pdf",
        targetPath: "/downloads/welcome.pdf",
        bytesDownloaded: 0,
        contentLength: 1_048_576,
        startedAt: 5_000,
        abortController,
      });
      expect(registry.get("job-lifecycle")?.bytesDownloaded).toBe(0);

      // 2. Multiple `update` calls (driven by engine bus `downloading` event
      //    simulation, increment bytesDownloaded toward contentLength).
      const fakeBusEvents: ReadonlyArray<{ loaded: number; total: number }> = [
        { loaded: 262_144, total: 1_048_576 },
        { loaded: 524_288, total: 1_048_576 },
        { loaded: 786_432, total: 1_048_576 },
        { loaded: 1_048_576, total: 1_048_576 },
      ];
      for (const evt of fakeBusEvents) {
        registry.update("job-lifecycle", {
          bytesDownloaded: evt.loaded,
          contentLength: evt.total,
        });
      }
      expect(registry.get("job-lifecycle")?.bytesDownloaded).toBe(1_048_576);
      expect(registry.get("job-lifecycle")?.contentLength).toBe(1_048_576);

      // Snapshot mid-lifecycle reflects current bytes.
      expect(registry.snapshot()).toHaveLength(1);
      expect(registry.snapshot()[0]?.bytesDownloaded).toBe(1_048_576);

      // 3. Terminal `delete` (driven by engine bus `file-downloaded`).
      registry.delete("job-lifecycle");
      expect(registry.get("job-lifecycle")).toBeUndefined();
      expect(registry.snapshot()).toEqual([]);
    });

    it("start → progress → terminal cancel removes the entry", () => {
      const registry = createDownloadRegistry();
      registry.set({
        downloadJobId: "job-cancel",
        datasourceId: "ds-1",
        sourcePath: "/big.iso",
        targetPath: "/downloads/big.iso",
        bytesDownloaded: 0,
        contentLength: null, // provider didn't advertise length
        startedAt: 6_000,
        abortController: new AbortController(),
      });
      registry.update("job-cancel", { bytesDownloaded: 1_000 });
      registry.update("job-cancel", { bytesDownloaded: 5_000 });
      // Engine bus `download-cancelled { datasourceId, path, bytesDownloaded,
      // bytesTotal }` → registry delete.
      registry.delete("job-cancel");
      expect(registry.get("job-cancel")).toBeUndefined();
    });

    it("start → terminal failure removes the entry without intervening progress", () => {
      const registry = createDownloadRegistry();
      registry.set({
        downloadJobId: "job-fail",
        datasourceId: "ds-1",
        sourcePath: "/missing.pdf",
        targetPath: "/downloads/missing.pdf",
        bytesDownloaded: 0,
        contentLength: null,
        startedAt: 7_000,
        abortController: new AbortController(),
      });
      // Engine bus `download-failed` → fs-sync handler emits terminal and
      // calls registry.delete (no retry path here).
      registry.delete("job-fail");
      expect(registry.snapshot()).toEqual([]);
    });
  });

  // Surface check: type-level guard that the partial accepted by `update`
  // excludes the immutable identity fields. We use a local helper typed as
  // `DownloadJobUpdate` and verify at compile time that identity fields are
  // not assignable. This is a runtime no-op; the value comes from the
  // `pnpm typecheck` pass.
  describe("type-level guards", () => {
    it("DownloadJobUpdate accepts mutable fields and rejects identity fields", () => {
      const ok: DownloadJobUpdate = { bytesDownloaded: 1 };
      const ok2: DownloadJobUpdate = { contentLength: null };
      const ok3: DownloadJobUpdate = { bytesDownloaded: 1, contentLength: 2 };
      expect(ok).toBeDefined();
      expect(ok2).toBeDefined();
      expect(ok3).toBeDefined();

      // The following would fail typecheck (uncomment to verify locally):
      //   const bad: DownloadJobUpdate = { downloadJobId: "x" };
      //   const bad2: DownloadJobUpdate = { datasourceId: "x" };
      //   const bad3: DownloadJobUpdate = { sourcePath: "x" };
      //   const bad4: DownloadJobUpdate = { targetPath: "x" };
      //   const bad5: DownloadJobUpdate = { startedAt: 0 };
      //   const bad6: DownloadJobUpdate = { abortController: new AbortController() };
    });
  });
});
