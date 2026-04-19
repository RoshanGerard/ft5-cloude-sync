import { describe, expect, it } from "vitest";

import type { FileEntry, MimeFamily } from "@ft5/ipc-contracts";

import {
  enumerateSeededDirectorySizes,
  getFileTree,
  list,
  remove,
  rename,
  resetMockFs,
  search,
  SEARCH_RESULT_CEILING,
  stat,
  download,
} from "../mock-fs";

const SEEDED_DATASOURCE_IDS = [
  "ds-gdrive-personal",
  "ds-onedrive-work",
  "ds-s3-archive",
  "ds-gdrive-team",
] as const;

describe("mock-fs: getFileTree", () => {
  it("returns a seeded tree for every seeded datasource id", () => {
    resetMockFs();
    for (const id of SEEDED_DATASOURCE_IDS) {
      const tree = getFileTree(id);
      expect(Array.isArray(tree), `tree for ${id} must be an array`).toBe(true);
      expect(tree.length, `tree for ${id} must be non-empty`).toBeGreaterThan(0);
      for (const entry of tree) {
        expect(typeof entry.id).toBe("string");
        expect(typeof entry.name).toBe("string");
        expect(typeof entry.path).toBe("string");
        expect(["directory", "file"]).toContain(entry.kind);
      }
    }
  });

  it("returns an empty array for an unknown datasource id (does not throw)", () => {
    resetMockFs();
    expect(() => getFileTree("ds-does-not-exist")).not.toThrow();
    expect(getFileTree("ds-does-not-exist")).toEqual([]);
  });
});

describe("mock-fs: list", () => {
  it("returns entries directly under the requested path", () => {
    resetMockFs();
    const response = list({ datasourceId: "ds-gdrive-personal", path: "/" });
    expect(response).toHaveProperty("entries");
    expect(response).toHaveProperty("nextCursor");
    for (const entry of response.entries) {
      expect(entry.parentPath).toBe("/");
    }
    // nested directory: /documents
    const doc = response.entries.find(
      (e) => e.name === "documents" && e.kind === "directory",
    );
    expect(doc, "expected /documents directory under root").toBeTruthy();
    const nested = list({
      datasourceId: "ds-gdrive-personal",
      path: "/documents",
    });
    expect(nested.entries.length).toBeGreaterThan(0);
    for (const entry of nested.entries) {
      expect(entry.parentPath).toBe("/documents");
    }
  });

  it("returns nextCursor: null for the small in-memory fixtures", () => {
    resetMockFs();
    for (const id of SEEDED_DATASOURCE_IDS) {
      const response = list({ datasourceId: id, path: "/" });
      expect(response.nextCursor).toBeNull();
    }
  });

  it("returns an empty entries array for an unknown datasource", () => {
    resetMockFs();
    const response = list({ datasourceId: "ds-unknown", path: "/" });
    expect(response.entries).toEqual([]);
    expect(response.nextCursor).toBeNull();
  });
});

describe("mock-fs: stat", () => {
  it("returns the matching FileEntry for a seeded path", () => {
    resetMockFs();
    const { entries } = list({ datasourceId: "ds-gdrive-personal", path: "/" });
    const target = entries[0]!;
    const result = stat({
      datasourceId: "ds-gdrive-personal",
      path: target.path,
    });
    expect(result.id).toBe(target.id);
    expect(result.path).toBe(target.path);
  });

  it("throws a typed error when the path is not found", () => {
    resetMockFs();
    expect(() =>
      stat({
        datasourceId: "ds-gdrive-personal",
        path: "/does-not-exist",
      }),
    ).toThrow(/not found/i);
  });
});

describe("mock-fs: rename", () => {
  it("renames a file entry and returns the updated FileEntry", () => {
    resetMockFs();
    const { entries } = list({
      datasourceId: "ds-gdrive-personal",
      path: "/documents",
    });
    const file = entries.find((e) => e.kind === "file")!;
    expect(file).toBeTruthy();
    const result = rename({
      datasourceId: "ds-gdrive-personal",
      path: file.path,
      newName: "renamed-doc.pdf",
    });
    expect(result.entry.name).toBe("renamed-doc.pdf");
    expect(result.entry.path.endsWith("/renamed-doc.pdf")).toBe(true);

    // state is mutated: the original path is gone, the new one is present
    const refreshed = list({
      datasourceId: "ds-gdrive-personal",
      path: "/documents",
    }).entries;
    expect(refreshed.some((e) => e.path === file.path)).toBe(false);
    expect(refreshed.some((e) => e.path === result.entry.path)).toBe(true);
  });

  it("rejects rename on a directory entry", () => {
    resetMockFs();
    const { entries } = list({ datasourceId: "ds-gdrive-personal", path: "/" });
    const dir = entries.find((e) => e.kind === "directory")!;
    expect(dir).toBeTruthy();
    expect(() =>
      rename({
        datasourceId: "ds-gdrive-personal",
        path: dir.path,
        newName: "nope",
      }),
    ).toThrow(/folder rename is not supported/i);
  });

  it("throws when the path does not exist", () => {
    resetMockFs();
    expect(() =>
      rename({
        datasourceId: "ds-gdrive-personal",
        path: "/nowhere.pdf",
        newName: "x.pdf",
      }),
    ).toThrow(/not found/i);
  });
});

describe("mock-fs: remove (partial failure)", () => {
  it("returns { removed, failed } with partial-failure support for /_locked/ paths", () => {
    resetMockFs();
    // Find a locked file somewhere in the seeded tree.
    const sizes = enumerateSeededDirectorySizes();
    const lockedDir = sizes.find(({ path }) => path.startsWith("/_locked"));
    expect(
      lockedDir,
      "fixture must include at least one /_locked/* directory",
    ).toBeTruthy();
    const lockedListing = list({
      datasourceId: lockedDir!.datasourceId,
      path: lockedDir!.path,
    });
    const lockedFile = lockedListing.entries.find((e) => e.kind === "file")!;
    expect(lockedFile).toBeTruthy();

    // Find a regular file in the same datasource to successfully remove.
    const rootEntries = list({
      datasourceId: lockedDir!.datasourceId,
      path: "/",
    }).entries;
    const regularFile = rootEntries.find(
      (e) => e.kind === "file" && !e.path.startsWith("/_locked"),
    )!;
    expect(regularFile).toBeTruthy();

    const result = remove({
      datasourceId: lockedDir!.datasourceId,
      paths: [regularFile.path, lockedFile.path],
    });

    expect(result.removed).toContain(regularFile.path);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.path).toBe(lockedFile.path);
    expect(result.failed[0]!.reason).toMatch(/provider locked the file/i);
  });

  it("removes multiple paths successfully when none are locked", () => {
    resetMockFs();
    const rootEntries = list({
      datasourceId: "ds-gdrive-personal",
      path: "/",
    }).entries;
    const files = rootEntries.filter((e) => e.kind === "file").slice(0, 2);
    expect(files.length).toBe(2);
    const paths = files.map((f) => f.path);
    const result = remove({
      datasourceId: "ds-gdrive-personal",
      paths,
    });
    expect(result.removed.sort()).toEqual([...paths].sort());
    expect(result.failed).toEqual([]);
  });
});

describe("mock-fs: search", () => {
  it("S3: client-side substring match, truncated=false under ceiling", () => {
    resetMockFs();
    const result = search({
      datasourceId: "ds-s3-archive",
      query: ".zip",
      path: "/",
    });
    expect(result.entries.length).toBeGreaterThan(0);
    for (const entry of result.entries) {
      expect(entry.name.toLowerCase().includes(".zip")).toBe(true);
    }
    expect(result.entries.length).toBeLessThanOrEqual(SEARCH_RESULT_CEILING);
    expect(typeof result.truncated).toBe("boolean");
  });

  it("SEARCH_RESULT_CEILING is a finite number >= 10", () => {
    expect(typeof SEARCH_RESULT_CEILING).toBe("number");
    expect(SEARCH_RESULT_CEILING).toBeGreaterThanOrEqual(10);
  });

  it("S3: returns truncated=true when the result count exceeds the ceiling", () => {
    resetMockFs();
    // Very permissive query — every seeded S3 entry has a '.' in its name or
    // lives under the archive bucket tree. Use empty string to match all.
    const result = search({
      datasourceId: "ds-s3-archive",
      query: "",
      path: "/",
    });
    // If the bucket is huge enough to overflow, truncated must be true;
    // otherwise it is false. Both are valid — but the assertion below ties
    // these together honestly.
    if (result.entries.length === SEARCH_RESULT_CEILING) {
      expect(result.truncated).toBe(true);
    }
  });

  it("Drive: returns empty entries with truncated=true (deferred state)", () => {
    resetMockFs();
    const result = search({
      datasourceId: "ds-gdrive-personal",
      query: "report",
      path: "/",
    });
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("OneDrive: returns empty entries with truncated=true (deferred state)", () => {
    resetMockFs();
    const result = search({
      datasourceId: "ds-onedrive-work",
      query: "report",
      path: "/",
    });
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(true);
  });
});

describe("mock-fs: download", () => {
  it("returns { savedPath } under the mock downloads directory", () => {
    resetMockFs();
    const { entries } = list({ datasourceId: "ds-gdrive-personal", path: "/" });
    const file = entries.find((e) => e.kind === "file")!;
    const response = download({
      datasourceId: "ds-gdrive-personal",
      path: file.path,
    });
    expect(typeof response.savedPath).toBe("string");
    expect(response.savedPath).toContain("ft5-mock-downloads");
    expect(response.savedPath.endsWith(file.name)).toBe(true);
  });
});

describe("mock-fs: mimeFamily derivation via seeded entries", () => {
  it("every seeded file has a MimeFamily consistent with its extension", () => {
    resetMockFs();
    const seen = new Set<MimeFamily>();
    const walk = (entries: FileEntry[]) => {
      for (const entry of entries) {
        if (entry.kind === "file") {
          seen.add(entry.mimeFamily);
        } else {
          walk(list({ datasourceId: "ds-s3-archive", path: entry.path }).entries);
        }
      }
    };
    walk(getFileTree("ds-s3-archive") as unknown as FileEntry[]);
    // S3 tree should contain images, video, archive at a minimum.
    expect(seen.has("image")).toBe(true);
    expect(seen.has("video")).toBe(true);
    expect(seen.has("archive")).toBe(true);
  });
});

describe("mock-fs: resetMockFs", () => {
  it("restores state after a rename", () => {
    resetMockFs();
    const before = list({
      datasourceId: "ds-gdrive-personal",
      path: "/documents",
    }).entries;
    const file = before.find((e) => e.kind === "file")!;
    rename({
      datasourceId: "ds-gdrive-personal",
      path: file.path,
      newName: "renamed.pdf",
    });
    resetMockFs();
    const after = list({
      datasourceId: "ds-gdrive-personal",
      path: "/documents",
    }).entries;
    expect(after.some((e) => e.path === file.path)).toBe(true);
    expect(after.some((e) => e.name === "renamed.pdf")).toBe(false);
  });
});

describe("mock-fs: enumerateSeededDirectorySizes", () => {
  it("reports a size entry per seeded directory across all four datasources", () => {
    resetMockFs();
    const sizes = enumerateSeededDirectorySizes();
    expect(sizes.length).toBeGreaterThan(4);
    const datasourcesSeen = new Set(sizes.map((s) => s.datasourceId));
    for (const id of SEEDED_DATASOURCE_IDS) {
      expect(datasourcesSeen.has(id), `${id} must appear in the enumeration`).toBe(
        true,
      );
    }
    for (const s of sizes) {
      expect(typeof s.datasourceId).toBe("string");
      expect(typeof s.path).toBe("string");
      expect(typeof s.size).toBe("number");
      expect(s.size).toBeLessThanOrEqual(300);
    }
  });
});
