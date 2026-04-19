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
  MimeFamily,
} from "../files.js";
import { FILES_CHANNELS } from "../files.js";

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
  it("list: { datasourceId, path } request, { entries, nextCursor } response", () => {
    const req: FilesListRequest = { datasourceId: "ds-1", path: "/" };
    const res: FilesListResponse = {
      entries: [],
      nextCursor: null,
    };
    expect(req.datasourceId).toBe("ds-1");
    expect(res.nextCursor).toBeNull();

    const page: FilesListResponse = {
      entries: [],
      nextCursor: "cursor-token",
    };
    expect(page.nextCursor).toBe("cursor-token");

    expectTypeOf<FilesListRequest>().toEqualTypeOf<{
      datasourceId: string;
      path: string;
    }>();
    expectTypeOf<FilesListResponse["nextCursor"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<FilesListResponse["entries"]>().toEqualTypeOf<FileEntry[]>();
  });

  it("stat: { datasourceId, path } request, { entry } response", () => {
    const req: FilesStatRequest = { datasourceId: "ds-1", path: "/report.pdf" };
    expect(req.path).toBe("/report.pdf");

    expectTypeOf<FilesStatRequest>().toEqualTypeOf<{
      datasourceId: string;
      path: string;
    }>();
    expectTypeOf<FilesStatResponse>().toEqualTypeOf<{ entry: FileEntry }>();
  });

  it("search: { datasourceId, query, path } request, { entries, truncated } response", () => {
    const req: FilesSearchRequest = {
      datasourceId: "ds-1",
      query: "budget",
      path: "/",
    };
    const res: FilesSearchResponse = { entries: [], truncated: false };
    expect(req.query).toBe("budget");
    expect(res.truncated).toBe(false);

    expectTypeOf<FilesSearchRequest>().toEqualTypeOf<{
      datasourceId: string;
      query: string;
      path: string;
    }>();
    expectTypeOf<FilesSearchResponse>().toEqualTypeOf<{
      entries: FileEntry[];
      truncated: boolean;
    }>();
  });

  it("rename: { datasourceId, path, newName } request, { entry } response", () => {
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

  it("remove: { datasourceId, paths } request, { removed, failed } response", () => {
    const req: FilesRemoveRequest = {
      datasourceId: "ds-1",
      paths: ["/a", "/b", "/c"],
    };
    const res: FilesRemoveResponse = {
      removed: ["/a", "/b"],
      failed: [{ path: "/c", reason: "provider locked the file" }],
    };
    expect(req.paths).toHaveLength(3);
    expect(res.removed).toEqual(["/a", "/b"]);
    expect(res.failed[0]?.reason).toBe("provider locked the file");

    expectTypeOf<FilesRemoveRequest>().toEqualTypeOf<{
      datasourceId: string;
      paths: string[];
    }>();
    expectTypeOf<FilesRemoveResponse>().toEqualTypeOf<{
      removed: string[];
      failed: { path: string; reason: string }[];
    }>();
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
  it("FILES_CHANNELS exposes exactly the six expected channels", () => {
    expect(FILES_CHANNELS.list).toBe("files:list");
    expect(FILES_CHANNELS.stat).toBe("files:stat");
    expect(FILES_CHANNELS.search).toBe("files:search");
    expect(FILES_CHANNELS.rename).toBe("files:rename");
    expect(FILES_CHANNELS.remove).toBe("files:remove");
    expect(FILES_CHANNELS.download).toBe("files:download");
  });

  it("FILES_CHANNELS is a readonly const with literal channel ids", () => {
    expectTypeOf<typeof FILES_CHANNELS>().toEqualTypeOf<{
      readonly list: "files:list";
      readonly stat: "files:stat";
      readonly search: "files:search";
      readonly rename: "files:rename";
      readonly remove: "files:remove";
      readonly download: "files:download";
    }>();
  });
});
