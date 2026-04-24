// Shared tagged-envelope shape for every `files:*` IPC response that crosses
// the main ↔ renderer bridge. The main-process handler forwards the exact
// envelope it receives from `fs-sync-service` so the renderer can branch on
// `.error.tag` for auth / network / rate-limit recovery UX — see
// openspec/changes/wire-file-explorer-to-service/design.md Decision 1.

export type FilesErrorTag =
  | "auth-revoked"
  | "disconnected"
  | "rate-limited"
  | "other";

export interface FilesErrorEnvelope {
  tag: FilesErrorTag;
  message: string;
  retryable: boolean;
  // Populated only when the provider surfaced a concrete backoff — typically
  // paired with `tag: "rate-limited"`. Absence means "unknown; use your own
  // policy", NOT "retry immediately".
  retryAfterMs?: number;
}

export type FilesEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: FilesErrorEnvelope };

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
// Successful list payload. `truncated` replaces the legacy `nextCursor` —
// the sync-service's engine returns one page per call and signals whether
// the provider had more results than fit. Paging cursors are no longer part
// of the renderer-facing contract.
export interface FilesListValue {
  entries: FileEntry[];
  truncated: boolean;
}
export type FilesListResponse = FilesEnvelope<FilesListValue>;

export interface FilesStatRequest {
  datasourceId: string;
  path: string;
}
export interface FilesStatValue {
  entry: FileEntry;
}
export type FilesStatResponse = FilesEnvelope<FilesStatValue>;

export interface FilesSearchRequest {
  datasourceId: string;
  query: string;
  path: string;
}
export interface FilesSearchValue {
  entries: FileEntry[];
  truncated: boolean;
}
export type FilesSearchResponse = FilesEnvelope<FilesSearchValue>;

export interface FilesRenameRequest {
  datasourceId: string;
  path: string;
  newName: string;
}
// `files:rename` is not part of the tagged-envelope rollout in
// wire-file-explorer-to-service Section 1; it stays on the legacy shape
// until a follow-up change widens it.
export interface FilesRenameResponse {
  entry: FileEntry;
}

// Per-path outcome inside a `files:remove` response. The outer envelope is
// `ok: true` whenever the service successfully ATTEMPTED all paths; each
// path's individual success/failure lives here. An `ok: false` envelope
// means the batch itself was rejected before any path was tried.
//
// Fields are `readonly` so the sync-service command contract and the
// renderer-facing response contract can share one declaration (the
// command layer already treats every shape as readonly).
export type FilesRemoveEntryResult =
  | { readonly path: string; readonly ok: true }
  | {
      readonly path: string;
      readonly ok: false;
      readonly error: {
        readonly tag: FilesErrorTag;
        readonly message: string;
      };
    };

// Canonical message the engine emits when a provider's native search
// endpoint is not yet wired (currently: Google Drive, OneDrive). The
// renderer's search dispatcher uses this exact string to distinguish a
// deferred-provider case from a generic "other" error, so callers MUST
// emit and match on the canonical value — not a paraphrase.
export const FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE =
  "provider native search is not wired yet; try a narrower path scope";

export interface FilesRemoveRequest {
  datasourceId: string;
  paths: string[];
}
export interface FilesRemoveValue {
  results: FilesRemoveEntryResult[];
}
export type FilesRemoveResponse = FilesEnvelope<FilesRemoveValue>;

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
