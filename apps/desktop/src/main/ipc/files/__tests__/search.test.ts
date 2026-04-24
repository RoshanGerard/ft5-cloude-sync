import { beforeEach, describe, expect, it } from "vitest";

import type {
  FilesSearchRequest,
  FilesSearchValue,
} from "@ft5/ipc-contracts";

import { resetMockFs, SEARCH_RESULT_CEILING } from "../mock-fs";
import { handleFilesSearch } from "../search";

// The handler now returns the tagged `{ ok: true; value } | { ok: false;
// error }` envelope (wire-file-explorer-to-service Decision 1). Every test
// in this file asserts the success path, so a tiny helper unwraps `value`
// and throws on `ok: false` with enough detail to point at the offending
// call-site.
function expectSearchValue(req: FilesSearchRequest): FilesSearchValue {
  const response = handleFilesSearch(req);
  if (!response.ok) {
    throw new Error(
      `handleFilesSearch(${req.datasourceId}, ${req.query}, ${req.path}) ` +
        `returned error envelope: ${response.error.tag} ${response.error.message}`,
    );
  }
  return response.value;
}

// The S3 fixture in mock-fs.ts (`ds-s3-archive`) seeds:
// - 6 files under "/"            (README.md, inventory.json, index.html,
//                                  changelog.log, release-notes.txt,
//                                  architecture.png)
// - 14 files under "/backups"    (12 snapshot-*.tar.gz + full-bundle.zip +
//                                  legacy-archive.7z)
// - 22 files under "/raw-footage"
// - 24 files under "/assets/2025"
// - 28 files under "/assets/2026"
// - 2 files under "/_locked"
// Total ~96 files — naturally exceeds the SEARCH_RESULT_CEILING (shared with
// other providers; semantics are generic), so tests that exercise truncation
// don't need a large-seed helper.
const S3_DATASOURCE_ID = "ds-s3-archive";

describe("handleFilesSearch: S3 client-side scan", () => {
  beforeEach(() => {
    resetMockFs();
  });

  it("returns matching file entries from the S3 fixture (substring match)", () => {
    const value = expectSearchValue({
      datasourceId: S3_DATASOURCE_ID,
      query: "snapshot",
      path: "/",
    });

    // "snapshot" matches the 12 snapshot-2026-*.tar.gz files under /backups.
    expect(value.entries.length).toBeGreaterThanOrEqual(2);
    for (const entry of value.entries) {
      expect(entry.kind).toBe("file");
      expect(entry.name.toLowerCase().includes("snapshot")).toBe(true);
    }
    expect(value.truncated).toBe(false);
  });

  it("matches case-insensitively on the S3 entry's name", () => {
    // Mixed case. The fixture has README.md at the root and "raw-footage"
    // related filenames. "ReADme" should still match README.md.
    const value = expectSearchValue({
      datasourceId: S3_DATASOURCE_ID,
      query: "ReADme",
      path: "/",
    });

    expect(value.entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of value.entries) {
      expect(entry.kind).toBe("file");
      expect(entry.name.toLowerCase().includes("readme")).toBe(true);
    }
  });

  it("returns empty entries with truncated=false when nothing matches", () => {
    const value = expectSearchValue({
      datasourceId: S3_DATASOURCE_ID,
      query: "zzzzz-nomatch-xyz",
      path: "/",
    });

    expect(value.entries).toEqual([]);
    expect(value.truncated).toBe(false);
  });

  describe("scope-root (path) is honored", () => {
    // ".png" matches /architecture.png at the root AND the 24 asset-*.png
    // files under /assets/2025. The outside-scope witness is the root file.
    const OUTSIDE_WITNESS_PATH = "/architecture.png";

    it("includes entries across the whole datasource when path is '/'", () => {
      const value = expectSearchValue({
        datasourceId: S3_DATASOURCE_ID,
        query: ".png",
        path: "/",
      });

      expect(
        value.entries.some((e) => e.path === OUTSIDE_WITNESS_PATH),
        "root-level /architecture.png must appear when scope is '/'",
      ).toBe(true);
    });

    it("restricts results to entries under the scope path", () => {
      const value = expectSearchValue({
        datasourceId: S3_DATASOURCE_ID,
        query: ".png",
        path: "/assets/2025",
      });

      // No entry from outside the /assets/2025 subtree.
      expect(
        value.entries.some((e) => e.path === OUTSIDE_WITNESS_PATH),
        "/architecture.png must NOT appear when scope is /assets/2025",
      ).toBe(false);

      // Every returned entry lives under the scope path.
      for (const entry of value.entries) {
        expect(
          entry.path.startsWith("/assets/2025/"),
          `entry ${entry.path} must be under the scope /assets/2025`,
        ).toBe(true);
        expect(entry.kind).toBe("file");
      }

      // We know there are 24 asset-*.png files under /assets/2025.
      expect(value.entries.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("scan ceiling", () => {
    it("reports truncated=true and caps entries at SEARCH_RESULT_CEILING when the scan hits the ceiling", () => {
      // "." matches every seeded S3 file (they all have extensions). The
      // fixture is ~96 files, well above any sane ceiling.
      const value = expectSearchValue({
        datasourceId: S3_DATASOURCE_ID,
        query: ".",
        path: "/",
      });

      expect(value.entries.length).toBe(SEARCH_RESULT_CEILING);
      expect(value.truncated).toBe(true);
      for (const entry of value.entries) {
        expect(entry.kind).toBe("file");
        expect(entry.name.toLowerCase().includes(".")).toBe(true);
      }
    });
  });

  it("never returns directory entries (S3 returns files only)", () => {
    // "." matches everything — if directories were ever returned, they'd
    // appear here.
    const value = expectSearchValue({
      datasourceId: S3_DATASOURCE_ID,
      query: ".",
      path: "/",
    });

    for (const entry of value.entries) {
      expect(entry.kind).toBe("file");
    }
  });
});
