import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  EntryKind,
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
  FilesUploadRequest,
  FilesUploadResponse,
  FilesUploadValue,
  MimeFamily,
} from "../files.js";
import { FILES_CHANNELS } from "../files.js";
import type { ConflictPolicy } from "../sync-service/commands.js";

describe("ipc-contracts files entry shape", () => {
  it("EntryKind is exactly two values", () => {
    expectTypeOf<EntryKind>().toEqualTypeOf<"directory" | "file">();
  });

  it("MimeFamily is exactly the eight documented values", () => {
    expectTypeOf<MimeFamily>().toEqualTypeOf<
      | "image"
      | "video"
      | "audio"
      | "document"
      | "archive"
      | "code"
      | "text"
      | "unknown"
    >();
  });

  it("FileEntry covers every documented field including providerMetadata", () => {
    const sample: FileEntry = {
      id: "entry-1",
      kind: "file",
      name: "report.pdf",
      path: "/projects/docs/report.pdf",
      parentPath: "/projects/docs",
      size: 1024,
      mimeFamily: "document",
      mimeType: "application/pdf",
      modifiedAt: "2026-04-19T00:00:00.000Z",
      createdAt: "2026-04-01T00:00:00.000Z",
      providerMetadata: {
        ownerEmail: "dev2@forti5.tech",
        shared: true,
        revision: 3,
        deletedAt: null,
      },
    };
    expect(sample.id).toBe("entry-1");
    expect(sample.providerMetadata.shared).toBe(true);

    const directory: FileEntry = {
      id: "dir-1",
      kind: "directory",
      name: "docs",
      path: "/projects/docs",
      parentPath: "/projects",
      size: null,
      mimeFamily: "unknown",
      mimeType: null,
      modifiedAt: "2026-04-19T00:00:00.000Z",
      createdAt: null,
      providerMetadata: {},
    };
    expect(directory.kind).toBe("directory");
    expect(directory.size).toBeNull();
    expect(directory.mimeType).toBeNull();
    expect(directory.createdAt).toBeNull();

    expectTypeOf<FileEntry["providerMetadata"]>().toEqualTypeOf<
      Record<string, string | number | boolean | null>
    >();
    expectTypeOf<FileEntry["size"]>().toEqualTypeOf<number | null>();
    expectTypeOf<FileEntry["mimeType"]>().toEqualTypeOf<string | null>();
    expectTypeOf<FileEntry["createdAt"]>().toEqualTypeOf<string | null>();
  });
});

describe("ipc-contracts files request/response pairs", () => {
  // Response envelope notes (wire-file-explorer-to-service Decision 1):
  //
  // `Files*Response` is what the renderer reads through `window.api.files.*`.
  // The main IPC handler forwards the `fs-sync-service` envelope verbatim so
  // the renderer can branch on `.error.tag` for auth / network / rate-limit
  // recovery UX. Per-path failures on `files:remove` travel inside
  // `value.results`, not at the envelope level.

  it("list: { datasourceId, path } request, ok envelope with { entries, truncated }", () => {
    const req: FilesListRequest = { datasourceId: "ds-1", path: "/" };
    const res: FilesListResponse = {
      ok: true,
      value: { entries: [], truncated: false },
    };
    expect(req.datasourceId).toBe("ds-1");
    if (res.ok) {
      expect(res.value.truncated).toBe(false);
    }

    const truncated: FilesListResponse = {
      ok: true,
      value: { entries: [], truncated: true },
    };
    if (truncated.ok) {
      expect(truncated.value.truncated).toBe(true);
    }

    const err: FilesListResponse = {
      ok: false,
      error: {
        tag: "auth-revoked",
        message: "Session expired; please reconnect.",
        retryable: false,
      },
    };
    if (!err.ok) {
      expect(err.error.tag).toBe("auth-revoked");
    }

    expectTypeOf<FilesListRequest>().toEqualTypeOf<{
      datasourceId: string;
      path: string;
    }>();
    expectTypeOf<FilesListResponse>().toEqualTypeOf<
      | {
          ok: true;
          value: { entries: FileEntry[]; truncated: boolean };
        }
      | {
          ok: false;
          error: {
            tag: "auth-revoked" | "disconnected" | "rate-limited" | "other";
            message: string;
            retryable: boolean;
            retryAfterMs?: number;
          };
        }
    >();
  });

  it("stat: { datasourceId, path } request, ok envelope with { entry }", () => {
    const req: FilesStatRequest = { datasourceId: "ds-1", path: "/report.pdf" };
    expect(req.path).toBe("/report.pdf");

    expectTypeOf<FilesStatRequest>().toEqualTypeOf<{
      datasourceId: string;
      path: string;
    }>();
    expectTypeOf<FilesStatResponse>().toEqualTypeOf<
      | { ok: true; value: { entry: FileEntry } }
      | {
          ok: false;
          error: {
            tag: "auth-revoked" | "disconnected" | "rate-limited" | "other";
            message: string;
            retryable: boolean;
            retryAfterMs?: number;
          };
        }
    >();
  });

  it("search: { datasourceId, query, path } request, ok envelope with { entries, truncated }", () => {
    const req: FilesSearchRequest = {
      datasourceId: "ds-1",
      query: "budget",
      path: "/",
    };
    const res: FilesSearchResponse = {
      ok: true,
      value: { entries: [], truncated: false },
    };
    expect(req.query).toBe("budget");
    if (res.ok) {
      expect(res.value.truncated).toBe(false);
    }

    const rate: FilesSearchResponse = {
      ok: false,
      error: {
        tag: "rate-limited",
        message: "Provider throttled the search request.",
        retryable: true,
        retryAfterMs: 4000,
      },
    };
    if (!rate.ok) {
      expect(rate.error.retryAfterMs).toBe(4000);
    }

    expectTypeOf<FilesSearchRequest>().toEqualTypeOf<{
      datasourceId: string;
      query: string;
      path: string;
    }>();
    expectTypeOf<FilesSearchResponse>().toEqualTypeOf<
      | {
          ok: true;
          value: { entries: FileEntry[]; truncated: boolean };
        }
      | {
          ok: false;
          error: {
            tag: "auth-revoked" | "disconnected" | "rate-limited" | "other";
            message: string;
            retryable: boolean;
            retryAfterMs?: number;
          };
        }
    >();
  });

  it("rename: { datasourceId, path, newName } request, { entry } response (unchanged)", () => {
    // `files:rename` is NOT part of the tagged-envelope rollout in Section 1
    // of wire-file-explorer-to-service; it stays on the legacy shape until a
    // follow-up change widens it. This assertion guards against accidental
    // drift while the shape is still the old one.
    const req: FilesRenameRequest = {
      datasourceId: "ds-1",
      path: "/old.txt",
      newName: "new.txt",
    };
    expect(req.newName).toBe("new.txt");

    expectTypeOf<FilesRenameRequest>().toEqualTypeOf<{
      datasourceId: string;
      path: string;
      newName: string;
    }>();
    expectTypeOf<FilesRenameResponse>().toEqualTypeOf<{ entry: FileEntry }>();
  });

  it("remove: { datasourceId, targets } request, ok envelope with per-path results", () => {
    const req: FilesRemoveRequest = {
      datasourceId: "ds-1",
      targets: [
        { path: "/a", handle: "h-a", kind: "file" },
        { path: "/b", handle: "h-b", kind: "file" },
        { path: "/c", handle: "h-c", kind: "file" },
      ],
    };
    const res: FilesRemoveResponse = {
      ok: true,
      value: {
        results: [
          { path: "/a", handle: "h-a", ok: true },
          { path: "/b", handle: "h-b", ok: true },
          {
            path: "/c",
            handle: "h-c",
            ok: false,
            error: { tag: "other", message: "provider locked the file" },
          },
        ],
      },
    };
    expect(req.targets).toHaveLength(3);
    if (res.ok) {
      expect(res.value.results).toHaveLength(3);
      const third = res.value.results[2]!;
      expect(third.ok).toBe(false);
      if (!third.ok) {
        expect(third.error.tag).toBe("other");
      }
    }

    expectTypeOf<FilesRemoveRequest>().toEqualTypeOf<{
      datasourceId: string;
      targets: Array<{
        path: string;
        handle: string;
        kind: "directory" | "file";
      }>;
    }>();
    expectTypeOf<FilesRemoveResponse>().toEqualTypeOf<
      | {
          ok: true;
          value: {
            results: Array<
              | { path: string; handle: string; ok: true }
              | {
                  path: string;
                  handle: string;
                  ok: false;
                  error: {
                    tag:
                      | "auth-revoked"
                      | "disconnected"
                      | "rate-limited"
                      | "other";
                    message: string;
                  };
                }
            >;
          };
        }
      | {
          ok: false;
          error: {
            tag: "auth-revoked" | "disconnected" | "rate-limited" | "other";
            message: string;
            retryable: boolean;
            retryAfterMs?: number;
          };
        }
    >();
  });

  it("upload: { datasourceId, sourcePath, targetPath, conflictPolicy } request, ok envelope with { jobId }", () => {
    // `files:upload` is the renderer-facing upload command introduced by the
    // `add-file-explorer-drag-drop-upload` change. It lands directly on the
    // sync-service's `sync:enqueue-upload` via the main-process handler —
    // the old `datasources:upload` surface is retired.
    const req: FilesUploadRequest = {
      datasourceId: "ds-1",
      sourcePath: "C:/Users/me/Documents/a.pdf",
      targetPath: "/projects/2026/a.pdf",
      conflictPolicy: "overwrite",
    };
    const duplicateReq: FilesUploadRequest = {
      datasourceId: "ds-1",
      sourcePath: "C:/Users/me/Documents/a.pdf",
      targetPath: "/projects/2026/a.pdf",
      conflictPolicy: "duplicate",
    };
    const skipReq: FilesUploadRequest = {
      datasourceId: "ds-1",
      sourcePath: "C:/Users/me/Documents/a.pdf",
      targetPath: "/projects/2026/a.pdf",
      conflictPolicy: "skip",
    };
    const ok: FilesUploadResponse = {
      ok: true,
      value: { jobId: "job-1" },
    };
    const err: FilesUploadResponse = {
      ok: false,
      error: {
        tag: "auth-revoked",
        message: "Session expired; please reconnect.",
        retryable: false,
      },
    };
    expect(req.conflictPolicy).toBe("overwrite");
    expect(duplicateReq.conflictPolicy).toBe("duplicate");
    expect(skipReq.conflictPolicy).toBe("skip");
    if (ok.ok) {
      expect(ok.value.jobId).toBe("job-1");
    }
    if (!err.ok) {
      expect(err.error.tag).toBe("auth-revoked");
    }

    expectTypeOf<FilesUploadRequest>().toEqualTypeOf<{
      datasourceId: string;
      sourcePath: string;
      targetPath: string;
      conflictPolicy: ConflictPolicy;
    }>();
    expectTypeOf<FilesUploadValue>().toEqualTypeOf<{ jobId: string }>();
    expectTypeOf<FilesUploadResponse>().toEqualTypeOf<
      | { ok: true; value: { jobId: string } }
      | {
          ok: false;
          error: {
            tag: "auth-revoked" | "disconnected" | "rate-limited" | "other";
            message: string;
            retryable: boolean;
            retryAfterMs?: number;
          };
        }
    >();
  });

  it("download: { datasourceId, path, toPath? } request, { savedPath } response", () => {
    const req: FilesDownloadRequest = {
      datasourceId: "ds-1",
      path: "/report.pdf",
    };
    const withTarget: FilesDownloadRequest = {
      datasourceId: "ds-1",
      path: "/report.pdf",
      toPath: "C:/Users/me/Downloads/report.pdf",
    };
    const res: FilesDownloadResponse = {
      savedPath: "C:/Users/me/Downloads/report.pdf",
    };
    expect(req.path).toBe("/report.pdf");
    expect(withTarget.toPath).toBe("C:/Users/me/Downloads/report.pdf");
    expect(res.savedPath).toBe("C:/Users/me/Downloads/report.pdf");

    expectTypeOf<FilesDownloadRequest>().toEqualTypeOf<{
      datasourceId: string;
      path: string;
      toPath?: string;
    }>();
    expectTypeOf<FilesDownloadResponse>().toEqualTypeOf<{ savedPath: string }>();
  });
});

describe("ipc-contracts files channel names", () => {
  it("FILES_CHANNELS exposes exactly the seven expected channels", () => {
    expect(FILES_CHANNELS.list).toBe("files:list");
    expect(FILES_CHANNELS.stat).toBe("files:stat");
    expect(FILES_CHANNELS.search).toBe("files:search");
    expect(FILES_CHANNELS.rename).toBe("files:rename");
    expect(FILES_CHANNELS.remove).toBe("files:remove");
    expect(FILES_CHANNELS.download).toBe("files:download");
    expect(FILES_CHANNELS.upload).toBe("files:upload");
    expect(Object.keys(FILES_CHANNELS).sort()).toEqual(
      [
        "list",
        "stat",
        "search",
        "rename",
        "remove",
        "download",
        "upload",
      ].sort(),
    );
  });

  it("FILES_CHANNELS is a readonly const with literal channel ids", () => {
    expectTypeOf<typeof FILES_CHANNELS>().toEqualTypeOf<{
      readonly list: "files:list";
      readonly stat: "files:stat";
      readonly search: "files:search";
      readonly rename: "files:rename";
      readonly remove: "files:remove";
      readonly download: "files:download";
      readonly upload: "files:upload";
    }>();
  });
});
