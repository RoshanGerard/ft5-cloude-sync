import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  EntryKind,
  FileEntry,
  FilesDownloadRequest,
  FilesDownloadResponse,
  FilesDownloadValue,
  FilesEnvelope,
  FilesErrorEnvelope,
  FilesListRequest,
  FilesListResponse,
  FilesRemoveRequest,
  FilesRemoveResponse,
  FilesRenameRequest,
  FilesRenameResponse,
  FilesRenameValue,
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
            tag:
              | "auth-revoked"
              | "disconnected"
              | "rate-limited"
              | "other"
              | "invalid-datasource"
              | "conflict"
              | "cancelled"
              | "exhausted-retries";
            message: string;
            retryable: boolean;
            retryAfterMs?: number;
            existingPath?: string;
            existingSize?: number;
            existingModifiedAt?: string;
            existingUploadJobId?: string;
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
            tag:
              | "auth-revoked"
              | "disconnected"
              | "rate-limited"
              | "other"
              | "invalid-datasource"
              | "conflict"
              | "cancelled"
              | "exhausted-retries";
            message: string;
            retryable: boolean;
            retryAfterMs?: number;
            existingPath?: string;
            existingSize?: number;
            existingModifiedAt?: string;
            existingUploadJobId?: string;
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
            tag:
              | "auth-revoked"
              | "disconnected"
              | "rate-limited"
              | "other"
              | "invalid-datasource"
              | "conflict"
              | "cancelled"
              | "exhausted-retries";
            message: string;
            retryable: boolean;
            retryAfterMs?: number;
            existingPath?: string;
            existingSize?: number;
            existingModifiedAt?: string;
            existingUploadJobId?: string;
          };
        }
    >();
  });

  // Legacy rename test removed: the request shape is now covered by
  // "rename: FilesRenameRequest carries conflictPolicy ..." below, and
  // the response shape is now covered by
  // "rename: FilesRenameResponse migrates to FilesEnvelope<FilesRenameValue>".

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
              | { readonly path: string; readonly handle: string; readonly ok: true }
              | {
                  readonly path: string;
                  readonly handle: string;
                  readonly ok: false;
                  readonly error: {
                    readonly tag:
                      | "auth-revoked"
                      | "disconnected"
                      | "rate-limited"
                      | "other"
                      | "invalid-datasource"
                      | "conflict"
                      | "cancelled"
                      | "exhausted-retries";
                    readonly message: string;
                  };
                }
            >;
          };
        }
      | {
          ok: false;
          error: {
            tag:
              | "auth-revoked"
              | "disconnected"
              | "rate-limited"
              | "other"
              | "invalid-datasource"
              | "conflict"
              | "cancelled"
              | "exhausted-retries";
            message: string;
            retryable: boolean;
            retryAfterMs?: number;
            existingPath?: string;
            existingSize?: number;
            existingModifiedAt?: string;
            existingUploadJobId?: string;
          };
        }
    >();
  });

  it("upload: { datasourceId, sourcePath, targetPath, conflictPolicy } request, ok envelope with { jobId }", () => {
    // `files:upload` is the renderer-facing upload command introduced by the
    // `add-file-explorer-drag-drop-upload` change. Post
    // migrate-upload-orchestration-out-of-engine chunk F it lands directly
    // on the sync-service's `files:upload` direct-RPC handler (the
    // pre-migration `sync:enqueue-upload` queue route was deleted).
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
            tag:
              | "auth-revoked"
              | "disconnected"
              | "rate-limited"
              | "other"
              | "invalid-datasource"
              | "conflict"
              | "cancelled"
              | "exhausted-retries";
            message: string;
            retryable: boolean;
            retryAfterMs?: number;
            existingPath?: string;
            existingSize?: number;
            existingModifiedAt?: string;
            existingUploadJobId?: string;
          };
        }
    >();
  });

  // Legacy download test removed: the request shape is now covered by
  // "download: FilesDownloadRequest.toPath is non-optional" below, and
  // the response shape is now covered by
  // "download: FilesDownloadResponse migrates to FilesEnvelope<FilesDownloadValue>".

  // ---- add-engine-rename-download additions -----------------------------
  // The block below mirrors the design.md / spec.md changes for this
  // change. The existing rename + download tests above remain in this
  // file until the implementation phase (§2.2 / §2.8 / §2.10 / §2.12)
  // updates them in lockstep with the type changes.

  it("rename: FilesRenameRequest carries conflictPolicy: \"fail\" | \"overwrite\" | \"keep-both\"", () => {
    // Per add-engine-rename-download design.md Decision 7: rename's
    // conflict policy is a tri-state distinct from upload's (which is
    // "overwrite" | "duplicate" | "skip"). The wire type is non-optional;
    // default semantics ("fail") are enforced at the consumer layer.
    const failReq: FilesRenameRequest = {
      datasourceId: "ds-1",
      path: "/old.pdf",
      newName: "new.pdf",
      conflictPolicy: "fail",
    };
    const overwriteReq: FilesRenameRequest = {
      datasourceId: "ds-1",
      path: "/old.pdf",
      newName: "new.pdf",
      conflictPolicy: "overwrite",
    };
    const keepBothReq: FilesRenameRequest = {
      datasourceId: "ds-1",
      path: "/old.pdf",
      newName: "new.pdf",
      conflictPolicy: "keep-both",
    };
    expect(failReq.conflictPolicy).toBe("fail");
    expect(overwriteReq.conflictPolicy).toBe("overwrite");
    expect(keepBothReq.conflictPolicy).toBe("keep-both");

    expectTypeOf<FilesRenameRequest>().toEqualTypeOf<{
      datasourceId: string;
      path: string;
      newName: string;
      conflictPolicy: "fail" | "overwrite" | "keep-both";
    }>();
  });

  it("FilesErrorEnvelope optionally carries existingPath alongside tag: \"conflict\"", () => {
    // Flat-optional shape mirrors the existing retryAfterMs? precedent
    // (NOT a discriminated union per design.md / specs/file-explorer
    // spec.md). Populated only when the response surfaces a rename
    // collision so the renderer's ConflictResolutionDialog can show the
    // colliding sibling path.
    const conflictErr: FilesErrorEnvelope = {
      tag: "conflict",
      message: "name collision at /parent/bar.pdf",
      retryable: false,
      existingPath: "/parent/bar.pdf",
    };
    expect(conflictErr.existingPath).toBe("/parent/bar.pdf");

    // The field is structurally optional — assertions about other tags
    // work without specifying it.
    const otherErr: FilesErrorEnvelope = {
      tag: "other",
      message: "boom",
      retryable: false,
    };
    expect(otherErr.existingPath).toBeUndefined();

    expectTypeOf<FilesErrorEnvelope>().toMatchTypeOf<{ existingPath?: string }>();
  });

  it("rename: FilesRenameResponse migrates to FilesEnvelope<FilesRenameValue>", () => {
    // §2.10 of add-engine-rename-download: drop the legacy
    // `{ entry: FileEntry }` shape (which lived through the
    // wire-file-explorer-to-service mock-fs era) in favor of the same
    // tagged envelope every other files:* response carries.
    const okFixture: FileEntry = {
      id: "ent-1",
      kind: "file",
      name: "renamed.pdf",
      path: "/projects/renamed.pdf",
      parentPath: "/projects",
      size: 1024,
      mimeFamily: "document",
      mimeType: "application/pdf",
      modifiedAt: "2026-04-28T00:00:00.000Z",
      createdAt: "2026-04-01T00:00:00.000Z",
      providerMetadata: {},
    };
    const ok: FilesRenameResponse = {
      ok: true,
      value: { entry: okFixture },
    };
    const conflict: FilesRenameResponse = {
      ok: false,
      error: {
        tag: "conflict",
        message: "name collision at /parent/bar.pdf",
        retryable: false,
        existingPath: "/parent/bar.pdf",
      },
    };
    if (ok.ok) {
      expect(ok.value.entry.name).toBe("renamed.pdf");
    }
    if (!conflict.ok) {
      expect(conflict.error.existingPath).toBe("/parent/bar.pdf");
    }

    expectTypeOf<FilesRenameValue>().toEqualTypeOf<{ entry: FileEntry }>();
    expectTypeOf<FilesRenameResponse>().toEqualTypeOf<
      FilesEnvelope<FilesRenameValue>
    >();
  });

  it("download: FilesDownloadResponse migrates to FilesEnvelope<FilesDownloadValue>", () => {
    // §2.12 of add-engine-rename-download: replaces the legacy
    // `{ savedPath: string }` literal. The new value carries `bytes`
    // because the service handler asserts `bytes === contentLength`
    // post-pipe and returns the count to the renderer.
    const ok: FilesDownloadResponse = {
      ok: true,
      value: {
        savedPath: "C:/Users/me/Downloads/welcome.pdf",
        bytes: 12345,
      },
    };
    const failed: FilesDownloadResponse = {
      ok: false,
      error: {
        tag: "other",
        message: "range not supported on this resource",
        retryable: false,
      },
    };
    if (ok.ok) {
      expect(ok.value.bytes).toBe(12345);
    }
    if (!failed.ok) {
      expect(failed.error.tag).toBe("other");
    }

    expectTypeOf<FilesDownloadValue>().toEqualTypeOf<{
      savedPath: string;
      bytes: number;
    }>();
    expectTypeOf<FilesDownloadResponse>().toEqualTypeOf<
      FilesEnvelope<FilesDownloadValue>
    >();
  });

  it("download: FilesDownloadRequest.toPath is non-optional", () => {
    // Per add-engine-rename-download: the service handler validates and
    // writes to toPath, so the renderer must resolve a concrete path
    // (default folder + filename, or showSaveDialog result) before
    // dispatch. The mock-fs era allowed `toPath?` so the main process
    // could fall back to a "saved-to-mock-path" stub; that fallback no
    // longer exists.
    //
    // `conflictPolicy` was added by `add-download-overwrite-confirm`
    // (Decision 1). Optional with default-to-`"fail"` semantics enforced
    // at the service handler.
    const req: FilesDownloadRequest = {
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "C:/Users/me/Downloads/welcome.pdf",
    };
    expect(req.toPath).toBe("C:/Users/me/Downloads/welcome.pdf");

    expectTypeOf<FilesDownloadRequest>().toEqualTypeOf<{
      datasourceId: string;
      path: string;
      toPath: string;
      conflictPolicy?: "fail" | "overwrite" | "keep-both";
    }>();
  });

  // ---- add-download-overwrite-confirm additions -------------------------
  // Phase A type-level pins for the conflict-resolution flow. The behavior
  // (handler gate, suffix loop, dialog hint metadata) is wired in later
  // phases; this block locks the wire-shape contract.

  it("FilesDownloadRequest accepts each conflictPolicy literal and rejects others", () => {
    // Per add-download-overwrite-confirm design.md Decision 1: the download
    // request reuses the rename `conflictPolicy` enum verbatim
    // ("fail" | "overwrite" | "keep-both"). Distinct from upload's
    // ("overwrite" | "duplicate" | "skip"). Optional on the wire — the
    // handler treats absence as `"fail"`.
    const failReq: FilesDownloadRequest = {
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "C:/Users/me/Downloads/welcome.pdf",
      conflictPolicy: "fail",
    };
    const overwriteReq: FilesDownloadRequest = {
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "C:/Users/me/Downloads/welcome.pdf",
      conflictPolicy: "overwrite",
    };
    const keepBothReq: FilesDownloadRequest = {
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "C:/Users/me/Downloads/welcome.pdf",
      conflictPolicy: "keep-both",
    };
    const omittedReq: FilesDownloadRequest = {
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "C:/Users/me/Downloads/welcome.pdf",
    };
    expect(failReq.conflictPolicy).toBe("fail");
    expect(overwriteReq.conflictPolicy).toBe("overwrite");
    expect(keepBothReq.conflictPolicy).toBe("keep-both");
    expect(omittedReq.conflictPolicy).toBeUndefined();

    // Reject upload-flavored / arbitrary literals — the rename enum is
    // intentionally distinct from the upload one. The `@ts-expect-error`
    // directive must sit on the line immediately preceding the offending
    // assignment, hence the per-property placement here.
    const wrongUploadLiteral: FilesDownloadRequest = {
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "C:/Users/me/Downloads/welcome.pdf",
      // @ts-expect-error — "skip" is an upload conflictPolicy literal, not a download one
      conflictPolicy: "skip",
    };
    const wrongUploadLiteral2: FilesDownloadRequest = {
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "C:/Users/me/Downloads/welcome.pdf",
      // @ts-expect-error — "duplicate" is an upload conflictPolicy literal, not a download one
      conflictPolicy: "duplicate",
    };
    const wrongArbitrary: FilesDownloadRequest = {
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "C:/Users/me/Downloads/welcome.pdf",
      // @ts-expect-error — arbitrary string is rejected by the literal union
      conflictPolicy: "yolo",
    };
    void wrongUploadLiteral;
    void wrongUploadLiteral2;
    void wrongArbitrary;

    expectTypeOf<FilesDownloadRequest["conflictPolicy"]>().toEqualTypeOf<
      "fail" | "overwrite" | "keep-both" | undefined
    >();
  });

  it("FilesErrorEnvelope optionally carries existingSize + existingModifiedAt for download conflict gate", () => {
    // Per add-download-overwrite-confirm Decision 3: the download conflict
    // gate populates both fields from `fs.stat(toPath)` (`stats.size`,
    // `stats.mtime.toISOString()`). Both are flat-optional — rename
    // callers MAY populate them but are not required to. The dialog
    // renders the hint block only when at least one is present.
    const conflictWithHints: FilesErrorEnvelope = {
      tag: "conflict",
      message: "destination already exists at /home/alice/Downloads/welcome.pdf",
      retryable: false,
      existingPath: "/home/alice/Downloads/welcome.pdf",
      existingSize: 4194304,
      existingModifiedAt: "2026-05-05T12:30:00.000Z",
    };
    expect(conflictWithHints.existingSize).toBe(4194304);
    expect(conflictWithHints.existingModifiedAt).toBe(
      "2026-05-05T12:30:00.000Z",
    );

    // Both fields are structurally optional — assertions about other
    // tags (or rename-flavored conflicts) work without specifying
    // either.
    const otherErr: FilesErrorEnvelope = {
      tag: "other",
      message: "boom",
      retryable: false,
    };
    expect(otherErr.existingSize).toBeUndefined();
    expect(otherErr.existingModifiedAt).toBeUndefined();

    const renameConflictPathOnly: FilesErrorEnvelope = {
      tag: "conflict",
      message: "name collision at /parent/bar.pdf",
      retryable: false,
      existingPath: "/parent/bar.pdf",
    };
    expect(renameConflictPathOnly.existingSize).toBeUndefined();
    expect(renameConflictPathOnly.existingModifiedAt).toBeUndefined();

    // Either hint field can be present alone — the dialog renders what
    // it has.
    const sizeOnly: FilesErrorEnvelope = {
      tag: "conflict",
      message: "destination exists",
      retryable: false,
      existingPath: "/x",
      existingSize: 1024,
    };
    const modifiedAtOnly: FilesErrorEnvelope = {
      tag: "conflict",
      message: "destination exists",
      retryable: false,
      existingPath: "/x",
      existingModifiedAt: "2026-05-05T12:30:00.000Z",
    };
    expect(sizeOnly.existingSize).toBe(1024);
    expect(modifiedAtOnly.existingModifiedAt).toBe("2026-05-05T12:30:00.000Z");

    expectTypeOf<FilesErrorEnvelope["existingSize"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<FilesErrorEnvelope["existingModifiedAt"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<FilesErrorEnvelope>().toMatchTypeOf<{
      existingSize?: number;
      existingModifiedAt?: string;
    }>();
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
