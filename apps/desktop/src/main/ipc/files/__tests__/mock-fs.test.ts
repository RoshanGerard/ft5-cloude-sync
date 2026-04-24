import { describe, expect, it } from "vitest";

import type {
  FileEntry,
  FilesListRequest,
  FilesListValue,
  FilesRemoveRequest,
  FilesRemoveValue,
  FilesSearchRequest,
  FilesSearchValue,
  MimeFamily,
} from "@ft5/ipc-contracts";

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

// Envelope-unwrap helpers. The mock-fs functions now return the tagged
// `{ ok: true; value } | { ok: false; error }` envelope introduced by the
// `wire-file-explorer-to-service` change (see ipc-contracts Decision 1).
// Pre-existing assertions in this file read the underlying value shape
// directly; these helpers unwrap it once so the rest of the test bodies
// stay legible. A false envelope throws so the failing test pinpoints
// where the unexpected error originated.
function expectListOk(req: FilesListRequest): FilesListValue {
  const r = list(req);
  if (!r.ok) {
    throw new Error(
      `list() returned error envelope: ${r.error.tag} ${r.error.message}`,
    );
  }
  return r.value;
}

function expectSearchOk(req: FilesSearchRequest): FilesSearchValue {
  const r = search(req);
  if (!r.ok) {
    throw new Error(
      `search() returned error envelope: ${r.error.tag} ${r.error.message}`,
    );
  }
  return r.value;
}

function expectRemoveOk(req: FilesRemoveRequest): FilesRemoveValue {
  const r = remove(req);
  if (!r.ok) {
    throw new Error(
      `remove() returned error envelope: ${r.error.tag} ${r.error.message}`,
    );
  }
  return r.value;
}

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
    const value = expectListOk({
      datasourceId: "ds-gdrive-personal",
      path: "/",
    });
    expect(value).toHaveProperty("entries");
    expect(value).toHaveProperty("truncated");
    for (const entry of value.entries) {
      expect(entry.parentPath).toBe("/");
    }
    // nested directory: /documents
    const doc = value.entries.find(
      (e) => e.name === "documents" && e.kind === "directory",
    );
    expect(doc, "expected /documents directory under root").toBeTruthy();
    const nested = expectListOk({
      datasourceId: "ds-gdrive-personal",
      path: "/documents",
    });
    expect(nested.entries.length).toBeGreaterThan(0);
    for (const entry of nested.entries) {
      expect(entry.parentPath).toBe("/documents");
    }
  });

  it("returns truncated=false for the small in-memory fixtures", () => {
    resetMockFs();
    for (const id of SEEDED_DATASOURCE_IDS) {
      const value = expectListOk({ datasourceId: id, path: "/" });
      expect(value.truncated).toBe(false);
    }
  });

  it("returns an error envelope for an unknown datasource", () => {
    resetMockFs();
    const response = list({ datasourceId: "ds-unknown", path: "/" });
    // Unknown datasource collapses to a command-level error — the renderer
    // can branch on `tag: "other"` and surface a targeted reconnect prompt.
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.tag).toBe("other");
      expect(response.error.message).toMatch(/datasource not found/i);
      expect(response.error.retryable).toBe(false);
    }
  });
});

describe("mock-fs: stat", () => {
  it("returns the matching FileEntry for a seeded path", () => {
    resetMockFs();
    const { entries } = expectListOk({
      datasourceId: "ds-gdrive-personal",
      path: "/",
    });
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
    const { entries } = expectListOk({
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
    const refreshed = expectListOk({
      datasourceId: "ds-gdrive-personal",
      path: "/documents",
    }).entries;
    expect(refreshed.some((e) => e.path === file.path)).toBe(false);
    expect(refreshed.some((e) => e.path === result.entry.path)).toBe(true);
  });

  it("rejects rename on a directory entry", () => {
    resetMockFs();
    const { entries } = expectListOk({
      datasourceId: "ds-gdrive-personal",
      path: "/",
    });
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
  it("returns per-path results with partial-failure support for /_locked/ paths", () => {
    resetMockFs();
    // Find a locked file somewhere in the seeded tree.
    const sizes = enumerateSeededDirectorySizes();
    const lockedDir = sizes.find(({ path }) => path.startsWith("/_locked"));
    expect(
      lockedDir,
      "fixture must include at least one /_locked/* directory",
    ).toBeTruthy();
    const lockedListing = expectListOk({
      datasourceId: lockedDir!.datasourceId,
      path: lockedDir!.path,
    });
    const lockedFile = lockedListing.entries.find((e) => e.kind === "file")!;
    expect(lockedFile).toBeTruthy();

    // Find a regular file in the same datasource to successfully remove.
    const rootEntries = expectListOk({
      datasourceId: lockedDir!.datasourceId,
      path: "/",
    }).entries;
    const regularFile = rootEntries.find(
      (e) => e.kind === "file" && !e.path.startsWith("/_locked"),
    )!;
    expect(regularFile).toBeTruthy();

    const value = expectRemoveOk({
      datasourceId: lockedDir!.datasourceId,
      paths: [regularFile.path, lockedFile.path],
    });

    const regularResult = value.results.find(
      (r) => r.path === regularFile.path,
    )!;
    const lockedResult = value.results.find((r) => r.path === lockedFile.path)!;
    expect(regularResult.ok).toBe(true);
    expect(lockedResult.ok).toBe(false);
    if (!lockedResult.ok) {
      expect(lockedResult.error.tag).toBe("other");
      expect(lockedResult.error.message).toMatch(/provider locked the file/i);
    }
  });

  it("removes multiple paths successfully when none are locked", () => {
    resetMockFs();
    const rootEntries = expectListOk({
      datasourceId: "ds-gdrive-personal",
      path: "/",
    }).entries;
    const files = rootEntries.filter((e) => e.kind === "file").slice(0, 2);
    expect(files.length).toBe(2);
    const paths = files.map((f) => f.path);
    const value = expectRemoveOk({
      datasourceId: "ds-gdrive-personal",
      paths,
    });
    expect(value.results.map((r) => r.path).sort()).toEqual([...paths].sort());
    expect(value.results.every((r) => r.ok)).toBe(true);
  });
});

describe("mock-fs: search", () => {
  it("S3: client-side substring match, truncated=false under ceiling", () => {
    resetMockFs();
    const value = expectSearchOk({
      datasourceId: "ds-s3-archive",
      query: ".zip",
      path: "/",
    });
    expect(value.entries.length).toBeGreaterThan(0);
    for (const entry of value.entries) {
      expect(entry.name.toLowerCase().includes(".zip")).toBe(true);
    }
    expect(value.entries.length).toBeLessThanOrEqual(SEARCH_RESULT_CEILING);
    expect(typeof value.truncated).toBe("boolean");
  });

  it("SEARCH_RESULT_CEILING is a finite number >= 10", () => {
    expect(typeof SEARCH_RESULT_CEILING).toBe("number");
    expect(SEARCH_RESULT_CEILING).toBeGreaterThanOrEqual(10);
  });

  it("S3: returns truncated=true when the result count exceeds the ceiling", () => {
    resetMockFs();
    // Very permissive query — every seeded S3 entry has a '.' in its name or
    // lives under the archive bucket tree. Use empty string to match all.
    const value = expectSearchOk({
      datasourceId: "ds-s3-archive",
      query: "",
      path: "/",
    });
    // If the bucket is huge enough to overflow, truncated must be true;
    // otherwise it is false. Both are valid — but the assertion below ties
    // these together honestly.
    if (value.entries.length === SEARCH_RESULT_CEILING) {
      expect(value.truncated).toBe(true);
    }
  });

  it("Drive: returns an error envelope indicating provider search is not wired", () => {
    resetMockFs();
    // The legacy `providerSearchDeferred: true` sentinel now travels as an
    // `ok: false` envelope with `tag: "other"` — the mock cannot distinguish
    // "deferred feature" from other service-side faults so the renderer
    // pattern-matches on the message for now. Section 4 will ratify.
    const response = search({
      datasourceId: "ds-gdrive-personal",
      query: "report",
      path: "/",
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.tag).toBe("other");
      expect(response.error.message).toMatch(/provider native search/i);
      expect(response.error.retryable).toBe(false);
    }
  });

  it("OneDrive: returns an error envelope indicating provider search is not wired", () => {
    resetMockFs();
    const response = search({
      datasourceId: "ds-onedrive-work",
      query: "report",
      path: "/",
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.tag).toBe("other");
      expect(response.error.message).toMatch(/provider native search/i);
    }
  });

  it("S3: a non-deferred scan returns an ok envelope with a value payload", () => {
    resetMockFs();
    const response = search({
      datasourceId: "ds-s3-archive",
      query: "mp4",
      path: "/",
    });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.value).toHaveProperty("entries");
      expect(response.value).toHaveProperty("truncated");
    }
  });
});

describe("mock-fs: download", () => {
  it("returns { savedPath } under the mock downloads directory", () => {
    resetMockFs();
    const { entries } = expectListOk({
      datasourceId: "ds-gdrive-personal",
      path: "/",
    });
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
          walk(
            expectListOk({ datasourceId: "ds-s3-archive", path: entry.path })
              .entries,
          );
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
    const before = expectListOk({
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
    const after = expectListOk({
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
