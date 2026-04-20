// Contract types for the FS Datasource Engine (see
// `openspec/changes/add-fs-datasource-engine`). These are the shared types
// that flow between the engine package (`@ft5/fs-datasource-engine`), the
// main-process IPC handlers, and the renderer's subscribers. They live here —
// not inside the engine — because the renderer must be able to narrow event
// payloads without importing the engine (engine carries provider SDKs and is
// main-process-only).

import type { ProviderId } from "./datasources.js";

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/**
 * `DatasourceType` is the public provider discriminator used across the
 * engine's generic surfaces. It is currently identical to `ProviderId` but
 * kept as a distinct alias so future surfaces that distinguish "provider
 * schema" from "runtime discriminator" (for example, mock / fake providers in
 * tests) have a dedicated extension point.
 */
export type DatasourceType = ProviderId;

/**
 * Hybrid addressing. The engine accepts both human-facing paths and
 * provider-native opaque handles. See Decision 3 in design.md.
 */
export type Target =
  | { kind: "path"; path: string }
  | { kind: "handle"; handle: string };

// ---------------------------------------------------------------------------
// Mime family + provider metadata
// ---------------------------------------------------------------------------

/**
 * High-level mime family. Kept deliberately small — the UI and engine care
 * about the family (what to render / how to stream) not the full mime string.
 * Raw mime strings travel inside the provider-specific metadata. Later phases
 * may extend this union; consumers should NOT rely on exhaustiveness.
 */
export type MimeFamily =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "archive"
  | "code"
  | "other";

/**
 * Provider-specific metadata attached to each `FileEntry`. Phase 1 shipped
 * empty-shape stubs; Phase 6 tightens the `amazon-s3` entry with SDK-native
 * fields returned by `@aws-sdk/client-s3`. `google-drive` and `onedrive`
 * remain `Record<string, unknown>` until Phases 7 and 8 refine them with
 * their SDK-specific fields (driveItem id, file id, etc.).
 *
 * The shape is intentionally extension-friendly: Phases 7/8 tighten their
 * entries without churning the engine-facing `ProviderMetadata<T>` alias.
 */
export interface ProviderMetadataMap {
  /** S3-native per-entry metadata (tightened in Phase 6). `bucket` + `key`
   * are always populated so audit log / telemetry can reconstruct the full
   * S3 object identity without re-parsing the `path`. `etag`, `storageClass`,
   * and `versionId` are populated when the source SDK response carries them
   * (e.g., `HeadObject` / `PutObject` responses; list responses populate
   * `etag` but not `storageClass`). */
  "amazon-s3": {
    bucket: string;
    key: string;
    etag?: string;
    storageClass?: string;
    versionId?: string;
  };
  /**
   * Google Drive per-entry metadata. Drive addresses files by `fileId`
   * rather than by path; `fileId` is always populated so callers that
   * retained an entry from a prior list can re-address it via the
   * `handle`-form `Target` even after a rename. `mimeType` and `parents`
   * are populated when the source SDK response carries them
   * (`files.list` / `files.get` with the default field set includes them).
   *
   * Path ambiguity surfacing. Drive permits multiple files with the same
   * name in the same parent, so a `path`-form `Target` can technically
   * resolve to more than one `fileId`. When the strategy detects this,
   * it keeps the oldest (first hit under `orderBy: "createdTime asc"`)
   * as the resolved entry and populates `ambiguous: true` plus
   * `ambiguousSiblings` listing the OTHER `fileId`s at the same
   * (parent, name). This turns what would otherwise be silent data loss
   * — the non-chosen siblings are unreachable via path addressing — into
   * handle-addressable recovery data. Consumers that show Drive listings
   * SHOULD surface an "ambiguous" badge when `ambiguous` is present and
   * offer a disambiguation flow using `ambiguousSiblings`.
   *
   * Only present when the condition holds — `ambiguous` is `true | undefined`
   * (not `false`), so callers can use presence as the signal.
   */
  "google-drive": {
    fileId: string;
    mimeType?: string;
    parents?: string[];
    ambiguous?: true;
    ambiguousSiblings?: string[];
  };
  onedrive: Record<string, unknown>;
}

export type ProviderMetadata<T extends DatasourceType> = ProviderMetadataMap[T];

// ---------------------------------------------------------------------------
// File entries
// ---------------------------------------------------------------------------

/**
 * A file or folder returned from the engine. Carries both `path` and
 * `handle` so callers can re-address the entry either way without a provider
 * round-trip.
 */
export interface FileEntry<T extends DatasourceType> {
  path: string;
  handle: string;
  name: string;
  kind: "file" | "folder";
  size?: number;
  /** Epoch milliseconds (UTC). */
  modifiedAt: number;
  mimeFamily: MimeFamily;
  providerMetadata: ProviderMetadata<T>;
}

/**
 * Extended metadata returned by `getMetadata`. In Phase 1 the shape is an
 * alias of `FileEntry<T>`; later phases will add richer optional fields
 * (checksum, eTag alias, parent chain) by switching this alias to an
 * `interface extends FileEntry<T>` without breaking existing consumers.
 */
export type FileMetadata<T extends DatasourceType> = FileEntry<T>;

// ---------------------------------------------------------------------------
// Event schema (Flavour B — generic per provider)
// ---------------------------------------------------------------------------

/**
 * Canonical event payload shape. Every provider's `PayloadMap` entry MUST
 * start from this shape to guarantee the 11 event names stay in lockstep
 * across providers. Phase 6–8 strategies override individual payload types
 * per provider (for example, `amazon-s3` tightens `"file-created"` to
 * `{ bucket, key, etag }`) by widening via a second generic layer or
 * interface merging — NOT by restating the key set.
 *
 * Intentionally file-local: this is an internal seam, not part of the
 * package's public surface. Downstream phases widen per provider.
 */
interface CanonicalEventPayloads {
  uploading: unknown;
  "upload-failed": unknown;
  "file-created": unknown;
  deleted: unknown;
  "delete-failed": unknown;
  authenticated: unknown;
  "authentication-failed": unknown;
  "token-refreshed": unknown;
  "token-expired": unknown;
  "status-changed": unknown;
  "rate-limited": unknown;
}

/**
 * Per-provider event payloads. Phase 1 declares each event name with
 * `unknown` payload (the payload shape is tightened per-strategy in Phases
 * 6–8). The event *names* are fixed — all 11 canonical names are required on
 * every provider so generic consumers can switch on `event` without knowing
 * which provider emitted it.
 */
export interface PayloadMap {
  "amazon-s3": CanonicalEventPayloads;
  "google-drive": CanonicalEventPayloads;
  onedrive: CanonicalEventPayloads;
}

/**
 * A single event on the engine's bus, narrowed by provider `T` and event
 * name `K`. `streaming` marks the event as subject to the throttle in the
 * engine's `EventBus` (see Decision 5). Terminal events (`file-created`,
 * `deleted`, `upload-failed`, etc.) never set `streaming: true`.
 */
export interface DatasourceEvent<
  T extends DatasourceType,
  K extends keyof PayloadMap[T],
> {
  event: K;
  datasourceType: T;
  datasourceId: string;
  ts: number;
  streaming?: true;
  payload: PayloadMap[T][K];
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Minimal auth result persisted by `CredentialStore` and consumed by
 * strategies. Kept flexible (`meta: Record<string, unknown>`) so providers
 * can stash tenant ids, region, and other auxiliary fields without schema
 * growth here.
 */
export interface AuthResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  meta?: Record<string, unknown>;
}

/** OAuth-flavoured auth intent. Host opens `authorizeUrl`, user returns a
 * code, host invokes `completeWith(code)` and awaits the resulting tokens.
 */
export interface OAuthIntent {
  kind: "oauth";
  authorizeUrl: string;
  completeWith(code: string): Promise<AuthResult>;
}

/** Credentials-form auth intent. Host renders a form matching `schema`,
 * collects values, invokes `submit(values)`.
 */
export interface CredentialsFormIntent {
  kind: "credentials-form";
  schema: import("./datasources.js").CredentialsSchema;
  submit(values: Record<string, unknown>): Promise<AuthResult>;
}

/**
 * Authentication intent returned by `client.authenticate()`. The engine
 * NEVER opens a UI; the Electron host completes the intent by invoking
 * `completeWith` (OAuth) or `submit` (form) with user-supplied values.
 */
export type AuthIntent = OAuthIntent | CredentialsFormIntent;

// ---------------------------------------------------------------------------
// Credential storage
// ---------------------------------------------------------------------------

/**
 * Shape persisted by `CredentialStore.put`. The store's implementation
 * (SqliteCredentialStore in Phase 4) serializes this to JSON then encrypts
 * with `safeStorage`. Plaintext MUST NOT leak outside the store's load path.
 */
export interface StoredCredentials {
  providerId: ProviderId;
  authResult: AuthResult;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/** Storage quota returned by `client.getQuota()` when the provider supports
 * it (see `ProviderCapabilities.quota`). Throws `Unsupported` otherwise.
 */
export interface Quota {
  used: number;
  quota: number;
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * The 8-tag taxonomy every strategy's `normalizeError` MUST map onto. See
 * Decision 9 in design.md. Consumers (UI toast, telemetry, audit log) switch
 * on `tag` for presentation.
 */
export type DatasourceErrorTag =
  | "auth-expired"
  | "auth-revoked"
  | "not-found"
  | "conflict"
  | "unsupported"
  | "rate-limited"
  | "network-error"
  | "provider-error";

export interface DatasourceErrorInit<T extends DatasourceType = DatasourceType> {
  tag: DatasourceErrorTag;
  datasourceType: T;
  datasourceId: string;
  retryable: boolean;
  retryAfterMs?: number;
  raw?: unknown;
  message?: string;
}

/**
 * The engine's normalized error class. Every provider-side exception is
 * converted to this shape by the strategy's `normalizeError` before being
 * emitted or thrown. `retryable` and `retryAfterMs` drive the UI's retry
 * policy; `raw` preserves the original payload for power consumers.
 *
 * Instances pass both `instanceof Error` and `instanceof DatasourceError`.
 */
export class DatasourceError<
  T extends DatasourceType = DatasourceType,
> extends Error {
  readonly tag: DatasourceErrorTag;
  readonly datasourceType: T;
  readonly datasourceId: string;
  readonly retryable: boolean;
  // `declare` keeps these type-only: no class-field initializer is emitted,
  // so `"retryAfterMs" in err` is `false` when the init did not supply one.
  // This matches the intent of `exactOptionalPropertyTypes`.
  declare readonly retryAfterMs?: number;
  declare readonly raw?: unknown;

  constructor(init: DatasourceErrorInit<T>) {
    super(init.message ?? `[${init.tag}] ${init.datasourceType}/${init.datasourceId}`);
    // Name set so stack traces show the class rather than plain `Error`.
    this.name = "DatasourceError";
    this.tag = init.tag;
    this.datasourceType = init.datasourceType;
    this.datasourceId = init.datasourceId;
    this.retryable = init.retryable;
    // `exactOptionalPropertyTypes` forbids assigning `undefined` to optional
    // props; assign only when the init carries a concrete value.
    if (init.retryAfterMs !== undefined) {
      this.retryAfterMs = init.retryAfterMs;
    }
    if (init.raw !== undefined) {
      this.raw = init.raw;
    }
    // Restore prototype so `instanceof` works after transpilation to ES5-style
    // super() calls. No-op on modern targets but cheap insurance.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
