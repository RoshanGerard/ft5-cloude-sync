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
import { FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE } from "@ft5/ipc-contracts";

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

  it("list(req) returns envelope with { entries, truncated } on success and round-trips cleanly", async () => {
    const response: FilesListResponse = {
      ok: true,
      value: {
        entries: [makeEntry(), makeEntry({ id: "entry-2", name: "notes.txt" })],
        truncated: false,
      },
    };
    vi.mocked(filesApi.list).mockResolvedValue(response);

    const req: FilesListRequest = { datasourceId: "ds-s3-archive", path: "/" };
    const result = await filesApi.list(req);

    expect(filesApi.list).toHaveBeenCalledTimes(1);
    expect(vi.mocked(filesApi.list).mock.calls[0]).toEqual([req]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value.entries)).toBe(true);
      expect(typeof result.value.truncated).toBe("boolean");
    }
    assertStructuredCloneSafe(result);
  });

  it("stat(req) returns envelope with { entry } on success and round-trips cleanly", async () => {
    const response: FilesStatResponse = {
      ok: true,
      value: { entry: makeEntry() },
    };
    vi.mocked(filesApi.stat).mockResolvedValue(response);

    const req: FilesStatRequest = {
      datasourceId: "ds-s3-archive",
      path: "/projects/report.pdf",
    };
    const result = await filesApi.stat(req);

    expect(filesApi.stat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(filesApi.stat).mock.calls[0]).toEqual([req]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entry.id).toBe("entry-1");
    }
    assertStructuredCloneSafe(result);
  });

  it("search(req) returns envelope with { entries, truncated } on success; deferred cases surface as ok:false with tag:other", async () => {
    // Branch 1: S3 scan, truncated true.
    const truncatedResponse: FilesSearchResponse = {
      ok: true,
      value: {
        entries: [makeEntry({ name: "match.pdf" })],
        truncated: true,
      },
    };
    vi.mocked(filesApi.search).mockResolvedValueOnce(truncatedResponse);

    const req1: FilesSearchRequest = {
      datasourceId: "ds-s3-archive",
      query: "pdf",
      path: "/",
    };
    const res1 = await filesApi.search(req1);
    expect(res1.ok).toBe(true);
    if (res1.ok) {
      expect(typeof res1.value.truncated).toBe("boolean");
      expect(res1.value.truncated).toBe(true);
    }
    assertStructuredCloneSafe(res1);

    // Branch 2: Drive or OneDrive provider-search-not-wired. Now encoded as
    // ok:false with tag:"other" and a canonical message.
    const deferredResponse: FilesSearchResponse = {
      ok: false,
      error: {
        tag: "other",
        message: FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE,
        retryable: false,
      },
    };
    vi.mocked(filesApi.search).mockResolvedValueOnce(deferredResponse);

    const req2: FilesSearchRequest = {
      datasourceId: "ds-google-drive",
      query: "invoice",
      path: "/",
    };
    const res2 = await filesApi.search(req2);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.error.tag).toBe("other");
      expect(res2.error.message).toContain("provider native search");
    }
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

  it("remove(req) returns envelope with per-path results; failures carry tag + message", async () => {
    const response: FilesRemoveResponse = {
      ok: true,
      value: {
        results: [
          { path: "/projects/a.txt", handle: "h-a", ok: true },
          { path: "/projects/b.txt", handle: "h-b", ok: true },
          {
            path: "/projects/c.txt",
            handle: "h-c",
            ok: false,
            error: { tag: "other", message: "provider locked the file" },
          },
        ],
      },
    };
    vi.mocked(filesApi.remove).mockResolvedValue(response);

    const req: FilesRemoveRequest = {
      datasourceId: "ds-s3-archive",
      targets: [
        { path: "/projects/a.txt", handle: "h-a", kind: "file" },
        { path: "/projects/b.txt", handle: "h-b", kind: "file" },
        { path: "/projects/c.txt", handle: "h-c", kind: "file" },
      ],
    };
    const result = await filesApi.remove(req);

    expect(filesApi.remove).toHaveBeenCalledTimes(1);
    expect(vi.mocked(filesApi.remove).mock.calls[0]).toEqual([req]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const successes = result.value.results.filter((r) => r.ok);
      const failures = result.value.results.filter((r) => !r.ok);
      expect(successes.every((r) => typeof r.path === "string")).toBe(true);
      expect(
        failures.every(
          (r) =>
            !r.ok &&
            typeof r.error.tag === "string" &&
            typeof r.error.message === "string",
        ),
      ).toBe(true);
    }
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
