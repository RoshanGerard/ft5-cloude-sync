// Shared tagged-envelope shape for every `files:*` IPC response that crosses
// the main ↔ renderer bridge. The main-process handler forwards the exact
// envelope it receives from `fs-sync-service` so the renderer can branch on
// `.error.tag` for auth / network / rate-limit recovery UX — see
// openspec/changes/wire-file-explorer-to-service/design.md Decision 1.

import type { ConflictPolicy } from "./sync-service/commands.js";

// Per add-invalid-datasource-state Decision 1, the tag union is exposed
// as an `as const` object + derived type (matching `FILES_CHANNELS` /
// `DATASOURCES_CHANNELS` convention). Net-new code references via
// `FilesErrorTag.InvalidDatasource`; existing literal references such as
// `tag === "auth-revoked"` continue to type-check because the derived
// type is the same string union.
//
// `"invalid-datasource"` (per add-invalid-datasource-state Decision 2)
// surfaces misconfigured datasources detected at the engine layer
// (`factory.create` shape rejection) or the service-side `resolveClient`
// adapter (missing credential file). Distinct from `"auth-revoked"` —
// auth-revoked means the provider terminated the OAuth grant; this tag
// means the local credential payload is missing or malformed.
export const FilesErrorTag = {
  AuthRevoked: "auth-revoked",
  Disconnected: "disconnected",
  RateLimited: "rate-limited",
  Other: "other",
  InvalidDatasource: "invalid-datasource",
  // `"conflict"` (per add-engine-rename-download design.md Decision 7)
  // surfaces a rename collision when conflictPolicy === "fail". Paired
  // with `existingPath` on the envelope so the renderer's
  // ConflictResolutionDialog can prompt with the colliding sibling path.
  Conflict: "conflict",
  // `"cancelled"` (per add-engine-rename-download §13 + spec.md "Cancel
  // mid-stream" scenario at line 78). Surfaces a user-driven cancel of an
  // in-flight `files:download` — the partial file at `toPath` is left on
  // disk and the handler emits a single `download-cancelled` event before
  // returning this envelope. Distinct from `"other"` because the renderer's
  // download toaster treats cancellation as a soft-state (no error toast,
  // partial-file disclosure UI) rather than a failure.
  Cancelled: "cancelled",
  // `"exhausted-retries"` (per add-download-resilience design.md Decision 7).
  // Surfaces terminal failure of an in-flight `files:download` after the
  // handler's environmental-retry budget has been spent (5 consecutive
  // mid-stream failures with no byte progress, OR the 30-min wall-time
  // ceiling). Both exhaustion modes share this tag; the discriminator
  // (count vs wall-time) lives in the `message` field as
  // `"exhausted-retries: <engineCause>"` or `"walltime-exceeded: <engineCause>"`.
  // Renderer toasts surface a Retry button; the `cause` engine-tag is
  // diagnostic-only and lives in `message`.
  ExhaustedRetries: "exhausted-retries",
} as const;
export type FilesErrorTag =
  (typeof FilesErrorTag)[keyof typeof FilesErrorTag];

export interface FilesErrorEnvelope {
  tag: FilesErrorTag;
  message: string;
  retryable: boolean;
  // Populated only when the provider surfaced a concrete backoff — typically
  // paired with `tag: "rate-limited"`. Absence means "unknown; use your own
  // policy", NOT "retry immediately".
  retryAfterMs?: number;
  // Populated only when `tag === "conflict"` (per add-engine-rename-download
  // design.md Decision 7) — surfaces the colliding remote sibling path so
  // the renderer's ConflictResolutionDialog can show it. Flat-optional
  // shape mirrors retryAfterMs (NOT a discriminated union) so callers can
  // read the field without re-narrowing on tag.
  existingPath?: string;
  // Populated by the `files:download` conflict gate (per
  // add-download-overwrite-confirm design.md Decision 3) from the same
  // `fs.stat(toPath)` call that detects existence — `stats.size` for
  // `existingSize`, `stats.mtime.toISOString()` for `existingModifiedAt`.
  // Both are flat-optional and may travel together or separately; the
  // renderer's RenameConflictDialog renders the hint block when at least
  // one is present and omits it when both are absent. Rename callers MAY
  // populate either field if the strategy already has the data on hand
  // (Drive / OneDrive metadata sometimes does), but are NOT required to —
  // the existing rename callsites continue to work unchanged with both
  // fields absent.
  existingSize?: number;
  existingModifiedAt?: string;
  // Populated only when `tag === "conflict"` is surfaced from the
  // `files:upload` concurrent-target guard (per
  // migrate-upload-orchestration-out-of-engine design.md Decision 10).
  // Carries the `uploadJobId` of the in-flight upload occupying the
  // `(datasourceId, targetPath)` slot so the renderer's Sonner error
  // toast can reference the existing toast. Flat-optional shape mirrors
  // `existingPath` / `retryAfterMs`. Conflicts on `files:rename` continue
  // to use `existingPath` only — rename has no job-identity concept.
  existingUploadJobId?: string;
}

export type FilesEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: FilesErrorEnvelope };

// Per unify-engine-delete-method design.md Decision 3, EntryKind is exposed
// as an `as const` object + derived type (mirroring `FilesErrorTag`). Net-new
// code references via `EntryKind.File` / `EntryKind.Directory`; existing
// literal references such as `kind === "file"` continue to type-check because
// the derived type is the same two-string union (non-breaking).
export const EntryKind = {
  Directory: "directory",
  File: "file",
} as const;
export type EntryKind = (typeof EntryKind)[keyof typeof EntryKind];

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
  // Per add-engine-listdirectory-pagination Decisions 1-3. Opaque
  // continuation cursor from the prior page's `nextCursor`; omitted on the
  // first page. The engine never inspects it — each strategy maps it to its
  // provider-native token. `pageSize` is the desired entries-per-page;
  // strategies clamp to their provider min/max and apply their own default
  // when omitted. Both optional — a request omitting them lists the first
  // page at the provider default.
  cursor?: string;
  pageSize?: number;
}
// Successful list payload. Per add-engine-listdirectory-pagination
// (Decisions 1 + 6) the engine returns exactly ONE provider page per call
// plus an opaque `nextCursor` continuation token (`null` when the listing is
// exhausted); the renderer holds the cursor and re-issues with it to load the
// next page. `truncated` is RETAINED but DERIVED — the sync-service handler
// sets `truncated = nextCursor !== null` (it is no longer hard-coded). A
// future cleanup change may remove `truncated` once the renderer reads
// `nextCursor` directly.
export interface FilesListValue {
  entries: FileEntry[];
  truncated: boolean;
  nextCursor: string | null;
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
  // Per add-engine-rename-download design.md Decision 7. The wire type is
  // non-optional; the renderer's store.rename action defaults to "fail"
  // when the user does not pick a policy via the conflict-resolution
  // dialog. Distinct from upload's ConflictPolicy
  // ("overwrite" | "duplicate" | "skip") because the rename UX has
  // different semantics — "fail" surfaces a conflict tag for the dialog
  // to re-prompt; "keep-both" auto-suffixes; "overwrite" replaces the
  // colliding sibling.
  conflictPolicy: "fail" | "overwrite" | "keep-both";
}
// Successful rename payload (per add-engine-rename-download §2.10:
// migrated from the legacy bare `{ entry }` shape into the same tagged
// envelope every other files:* response carries). The renderer pulls
// the renamed entry off `value.entry` after narrowing on `ok: true`.
export interface FilesRenameValue {
  entry: FileEntry;
}
export type FilesRenameResponse = FilesEnvelope<FilesRenameValue>;

// Per-target outcome inside a `files:remove` response. The outer envelope
// is `ok: true` whenever the service successfully ATTEMPTED all targets;
// each target's individual success/failure lives here. An `ok: false`
// envelope means the batch itself was rejected before any target was
// tried.
//
// `handle` is the authoritative engine identifier of the removed entry —
// the renderer correlates results back to its own entry rows by handle,
// not by `path`. This matters on providers like Google Drive where two
// entries can share a path but always have distinct handles; correlating
// by path would let an optimistic-removal pass collapse both duplicates
// when only one was actually deleted.
//
// Fields are `readonly` so the sync-service command contract and the
// renderer-facing response contract can share one declaration (the
// command layer already treats every shape as readonly).
export type FilesRemoveEntryResult =
  | { readonly path: string; readonly handle: string; readonly ok: true }
  | {
      readonly path: string;
      readonly handle: string;
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

// Per-entry deletion target. `handle` is the authoritative address; `path`
// is preserved so the per-path response envelope matches back to the
// renderer's display keys. `kind` is passed straight to the engine's
// unified `delete(target, entryKind)` (unify-engine-delete-method),
// avoiding a second round-trip to `getMetadata` — that round-trip was
// itself ambiguity-vulnerable on providers (notably Google Drive) that
// allow multiple entries at the same path. See files-remove.ts for the
// end-to-end story.
//
// Rename / Download are currently mock-fs only; when the sibling change
// `add-engine-rename-download` lands, its contracts SHOULD adopt the same
// handle-first pattern.
export interface FilesRemoveTarget {
  path: string;
  handle: string;
  kind: EntryKind;
}

export interface FilesRemoveRequest {
  datasourceId: string;
  targets: FilesRemoveTarget[];
}
export interface FilesRemoveValue {
  results: FilesRemoveEntryResult[];
}
export type FilesRemoveResponse = FilesEnvelope<FilesRemoveValue>;

export interface FilesDownloadRequest {
  datasourceId: string;
  path: string;
  // Required as of add-engine-rename-download: the service handler
  // validates and writes to this path. The renderer resolves it from
  // user preferences (default folder + filename, or showSaveDialog) and
  // forwards. The mock-fs era allowed `toPath?` so the main process
  // could fall back to a "saved-to-mock-path" stub; that fallback no
  // longer exists.
  toPath: string;
  // Per add-download-overwrite-confirm design.md Decision 1. The wire
  // type is OPTIONAL with default-to-`"fail"` semantics enforced by the
  // service handler — a request that omits `conflictPolicy` is treated
  // as `"fail"`, which surfaces a `tag: "conflict"` envelope when a file
  // already exists at `toPath`. The renderer's download orchestrator
  // sets the field explicitly on every dispatch (initial = `"fail"`;
  // re-dispatch after the conflict dialog = the user's choice). Reuses
  // the rename `conflictPolicy` enum verbatim — distinct from upload's
  // (`"overwrite" | "duplicate" | "skip"`) — so the codebase keeps two
  // conflict-policy vocabularies, not three.
  conflictPolicy?: "fail" | "overwrite" | "keep-both";
}
// Successful download payload (per add-engine-rename-download §2.12:
// migrated from the legacy bare `{ savedPath }` shape into the tagged
// envelope). `bytes` is the post-pipe `fs.stat(toPath).size` value the
// service handler asserts against `contentLength`; surfacing it lets
// the renderer's success toast show the file size and lets test
// fixtures check the byte count without re-statting on disk.
export interface FilesDownloadValue {
  savedPath: string;
  bytes: number;
}
export type FilesDownloadResponse = FilesEnvelope<FilesDownloadValue>;

// `files:upload` is the renderer-facing upload command introduced by
// `add-file-explorer-drag-drop-upload` and migrated to a direct-RPC
// service handler by `migrate-upload-orchestration-out-of-engine`. The
// main-process handler is now a thin proxy over the service's
// `files:upload` command (was `sync:enqueue-upload` pre-migration).
// Lifecycle events (`uploading` / `file-created` / `upload-failed` /
// `upload-cancelled`) flow on `sync:event-stream` keyed by the service-
// minted `uploadJobId` — the legacy `datasources:upload:progress`
// channel + the `transactionId`-keyed translation layer are gone (§7.5
// / §13.4).
//
// `sourcePath` is an absolute OS path (the renderer receives it either
// from the OS drop payload or via `datasources:pick-files-to-upload`).
// `targetPath` is an absolute datasource path, e.g. `/projects/2026/a.pdf`.
// `ConflictPolicy` is reused from the sync-service command contract so a
// single canonical union governs every upload surface.
export interface FilesUploadRequest {
  datasourceId: string;
  sourcePath: string;
  targetPath: string;
  conflictPolicy: ConflictPolicy;
}
export interface FilesUploadValue {
  /**
   * Service-minted upload job identifier. Per
   * `migrate-upload-orchestration-out-of-engine` the field is the canonical
   * `uploadJobId` (parallel to `downloadJobId` in `FilesDownloadValue`):
   * the renderer keys its in-flight upload toasts on this id and uses it
   * for cancellation via `sync:cancel-upload`. The legacy queue model
   * specified this field but never populated it with the service-level
   * key — it surfaces the engine-minted `transactionId` in the older
   * `sync:enqueue-upload` flow. After this migration, `files:upload` is
   * a direct RPC and `jobId` here is always the service-minted
   * `uploadJobId`.
   */
  jobId: string;
}
export type FilesUploadResponse = FilesEnvelope<FilesUploadValue>;

export const FILES_CHANNELS = {
  list: "files:list",
  stat: "files:stat",
  search: "files:search",
  rename: "files:rename",
  remove: "files:remove",
  download: "files:download",
  upload: "files:upload",
} as const;
