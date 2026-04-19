export type EntryKind = "directory" | "file";

export type MimeFamily =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "archive"
  | "code"
  | "text"
  | "unknown";

export interface FileEntry {
  id: string;
  kind: EntryKind;
  name: string;
  path: string;
  parentPath: string;
  size: number | null;
  mimeFamily: MimeFamily;
  mimeType: string | null;
  modifiedAt: string;
  createdAt: string | null;
  providerMetadata: Record<string, string | number | boolean | null>;
}

export interface FilesListRequest {
  datasourceId: string;
  path: string;
}
export interface FilesListResponse {
  entries: FileEntry[];
  nextCursor: string | null;
}

export interface FilesStatRequest {
  datasourceId: string;
  path: string;
}
export interface FilesStatResponse {
  entry: FileEntry;
}

export interface FilesSearchRequest {
  datasourceId: string;
  query: string;
  path: string;
}
export interface FilesSearchResponse {
  entries: FileEntry[];
  truncated: boolean;
  // True when the provider's native search API is not yet wired (Drive /
  // OneDrive in v1). Distinguishes "scan truncated" (truncated=true, this
  // field absent/false) from "provider search deferred" (truncated=true,
  // this field=true + entries=[]). Phase 7 UI surfaces the two differently.
  providerSearchDeferred?: boolean;
}

export interface FilesRenameRequest {
  datasourceId: string;
  path: string;
  newName: string;
}
export interface FilesRenameResponse {
  entry: FileEntry;
}

export interface FilesRemoveRequest {
  datasourceId: string;
  paths: string[];
}
export interface FilesRemoveFailure {
  path: string;
  reason: string;
}
export interface FilesRemoveResponse {
  removed: string[];
  failed: FilesRemoveFailure[];
}

export interface FilesDownloadRequest {
  datasourceId: string;
  path: string;
  toPath?: string;
}
export interface FilesDownloadResponse {
  savedPath: string;
}

export const FILES_CHANNELS = {
  list: "files:list",
  stat: "files:stat",
  search: "files:search",
  rename: "files:rename",
  remove: "files:remove",
  download: "files:download",
} as const;
