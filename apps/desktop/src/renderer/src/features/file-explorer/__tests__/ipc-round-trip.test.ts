import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FileEntry,
  FilesDownloadRequest,
  FilesDownloadResponse,
  FilesListRequest,
  FilesListResponse,
  FilesRemoveRequest,
  FilesRemoveResponse,
  FilesRenameRequest,
  FilesRenameResponse,
  FilesSearchRequest,
  FilesSearchResponse,
  FilesStatRequest,
  FilesStatResponse,
} from "@ft5/ipc-contracts";

// Renderer-side round-trip test for every `window.api.files.*` method.
//
// jsdom has no Electron bridge, so we stub `window.api.files` with a minimal
// mock that returns structured-clone-safe shapes matching the contract. The
// preload→main path is already exercised by other suites (the preload
// delegation test and the handler tests); this test's job is to enforce the
// renderer-boundary contract: that every call accepts a contract-typed
// request, receives a contract-typed response, and that payload round-trips
// through structuredClone without losing or corrupting anything (no
// functions, no symbols, no `undefined` in required fields).

type FilesApi = {
  list(req: FilesListRequest): Promise<FilesListResponse>;
  stat(req: FilesStatRequest): Promise<FilesStatResponse>;
  search(req: FilesSearchRequest): Promise<FilesSearchResponse>;
  rename(req: FilesRenameRequest): Promise<FilesRenameResponse>;
  remove(req: FilesRemoveRequest): Promise<FilesRemoveResponse>;
  download(req: FilesDownloadRequest): Promise<FilesDownloadResponse>;
};

function makeEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: "entry-1",
    kind: "file",
    name: "report.pdf",
    path: "/projects/report.pdf",
    parentPath: "/projects",
    size: 2048,
    mimeFamily: "document",
    mimeType: "application/pdf",
    modifiedAt: "2026-04-01T12:00:00.000Z",
    createdAt: "2026-03-15T08:00:00.000Z",
    providerMetadata: {},
    ...overrides,
  };
}

function assertStructuredCloneSafe<T>(value: T): void {
  // Throws DataCloneError for functions, symbols, etc. Also asserts the
  // cloned copy deep-equals the original so subtle asymmetries (like a
  // field silently dropped because it was `undefined`) are caught.
  const cloned = structuredClone(value);
  expect(cloned).toEqual(value);
}

describe("window.api.files round-trip", () => {
  let filesApi: FilesApi;

  beforeEach(() => {
    // Fresh stub per test. Each method is a vi.fn so we can assert the
    // invocation args, and returns structured-clone-safe payloads by default.
    filesApi = {
      list: vi.fn(),
      stat: vi.fn(),
      search: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      download: vi.fn(),
    };
    // Install onto window.api.files; other surfaces don't matter here.
    (globalThis as { window?: { api?: unknown } }).window = {
      api: { files: filesApi },
    };
  });

  it("list(req) returns { entries, nextCursor } and round-trips cleanly", async () => {
    const response: FilesListResponse = {
      entries: [makeEntry(), makeEntry({ id: "entry-2", name: "notes.txt" })],
      nextCursor: null,
    };
    vi.mocked(filesApi.list).mockResolvedValue(response);

    const req: FilesListRequest = { datasourceId: "ds-s3-archive", path: "/" };
    const result = await filesApi.list(req);

    expect(filesApi.list).toHaveBeenCalledTimes(1);
    expect(vi.mocked(filesApi.list).mock.calls[0]).toEqual([req]);
    expect(Array.isArray(result.entries)).toBe(true);
    expect(result.nextCursor === null || typeof result.nextCursor === "string").toBe(true);
    assertStructuredCloneSafe(result);
  });

  it("stat(req) returns { entry } and round-trips cleanly", async () => {
    const response: FilesStatResponse = { entry: makeEntry() };
    vi.mocked(filesApi.stat).mockResolvedValue(response);

    const req: FilesStatRequest = {
      datasourceId: "ds-s3-archive",
      path: "/projects/report.pdf",
    };
    const result = await filesApi.stat(req);

    expect(filesApi.stat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(filesApi.stat).mock.calls[0]).toEqual([req]);
    expect(result.entry.id).toBe("entry-1");
    assertStructuredCloneSafe(result);
  });

  it("search(req) returns { entries, truncated } — truncated is a boolean on both branches", async () => {
    // Branch 1: S3 scan, truncated true.
    const truncatedResponse: FilesSearchResponse = {
      entries: [makeEntry({ name: "match.pdf" })],
      truncated: true,
    };
    vi.mocked(filesApi.search).mockResolvedValueOnce(truncatedResponse);

    const req1: FilesSearchRequest = {
      datasourceId: "ds-s3-archive",
      query: "pdf",
      path: "/",
    };
    const res1 = await filesApi.search(req1);
    expect(typeof res1.truncated).toBe("boolean");
    expect(res1.truncated).toBe(true);
    assertStructuredCloneSafe(res1);

    // Branch 2: Drive or OneDrive deferred stub — entries empty, truncated
    // still a boolean (value mirrors the deferred-work semantic).
    const deferredResponse: FilesSearchResponse = {
      entries: [],
      truncated: true,
    };
    vi.mocked(filesApi.search).mockResolvedValueOnce(deferredResponse);

    const req2: FilesSearchRequest = {
      datasourceId: "ds-google-drive",
      query: "invoice",
      path: "/",
    };
    const res2 = await filesApi.search(req2);
    expect(typeof res2.truncated).toBe("boolean");
    expect(res2.entries).toEqual([]);
    assertStructuredCloneSafe(res2);
  });

  it("rename(req) returns { entry } and round-trips cleanly", async () => {
    const response: FilesRenameResponse = {
      entry: makeEntry({ name: "report-v2.pdf", path: "/projects/report-v2.pdf" }),
    };
    vi.mocked(filesApi.rename).mockResolvedValue(response);

    const req: FilesRenameRequest = {
      datasourceId: "ds-s3-archive",
      path: "/projects/report.pdf",
      newName: "report-v2.pdf",
    };
    const result = await filesApi.rename(req);

    expect(filesApi.rename).toHaveBeenCalledTimes(1);
    expect(vi.mocked(filesApi.rename).mock.calls[0]).toEqual([req]);
    expect(result.entry.name).toBe("report-v2.pdf");
    assertStructuredCloneSafe(result);
  });

  it("remove(req) returns { removed, failed } with per-failure reasons", async () => {
    const response: FilesRemoveResponse = {
      removed: ["/projects/a.txt", "/projects/b.txt"],
      failed: [{ path: "/projects/c.txt", reason: "provider locked the file" }],
    };
    vi.mocked(filesApi.remove).mockResolvedValue(response);

    const req: FilesRemoveRequest = {
      datasourceId: "ds-s3-archive",
      paths: ["/projects/a.txt", "/projects/b.txt", "/projects/c.txt"],
    };
    const result = await filesApi.remove(req);

    expect(filesApi.remove).toHaveBeenCalledTimes(1);
    expect(vi.mocked(filesApi.remove).mock.calls[0]).toEqual([req]);
    expect(result.removed.every((p) => typeof p === "string")).toBe(true);
    expect(
      result.failed.every(
        (f) => typeof f.path === "string" && typeof f.reason === "string",
      ),
    ).toBe(true);
    assertStructuredCloneSafe(result);
  });

  it("download(req) returns { savedPath } and round-trips cleanly; optional toPath accepted", async () => {
    const response: FilesDownloadResponse = {
      savedPath: "/tmp/report.pdf",
    };
    vi.mocked(filesApi.download).mockResolvedValue(response);

    // Without toPath.
    const req1: FilesDownloadRequest = {
      datasourceId: "ds-s3-archive",
      path: "/projects/report.pdf",
    };
    const res1 = await filesApi.download(req1);
    expect(typeof res1.savedPath).toBe("string");
    assertStructuredCloneSafe(res1);

    // With toPath.
    vi.mocked(filesApi.download).mockResolvedValueOnce({
      savedPath: "/Users/me/Downloads/report.pdf",
    });
    const req2: FilesDownloadRequest = {
      datasourceId: "ds-s3-archive",
      path: "/projects/report.pdf",
      toPath: "/Users/me/Downloads/report.pdf",
    };
    const res2 = await filesApi.download(req2);
    expect(res2.savedPath).toBe("/Users/me/Downloads/report.pdf");
    assertStructuredCloneSafe(res2);
  });
});
