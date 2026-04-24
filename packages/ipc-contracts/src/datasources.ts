import type { DatasourceErrorTag } from "./fs-datasource-engine.js";

export type DatasourceStatus = "connected" | "syncing" | "paused" | "error";

export interface DatasourceUsage {
  used: number;
  quota: number;
}

export interface DatasourceSummary {
  id: string;
  displayName: string;
  providerId: string;
  status: DatasourceStatus;
  lastSyncAt: number | null;
  itemCount: number;
  usage?: DatasourceUsage;
  errorReason?: string;
  /**
   * Taxonomy tag describing the last-observed engine error, or `null` when
   * the datasource is NOT in the `error` status. Lets the renderer
   * discriminate auth-class errors (to render `AuthErrorBanner`) from
   * transport/provider errors (bare error paragraph) without parsing the
   * human-readable `errorReason`.
   *
   * Required-when-errored (see `ErroredDatasourceSummary`). The runtime
   * invariant — `errorKind` non-null iff `status === "error"` — is enforced
   * by the main-process summary-builder in Group 5, not at the type level:
   * converting `DatasourceSummary` into a discriminated union would ripple
   * through 30+ construction sites and is explicitly out of Group 2 scope.
   * Added by `add-drive-oauth-browser-consent`.
   */
  errorKind: DatasourceErrorTag | null;
}

/**
 * Narrowed projection of `DatasourceSummary` for the errored case:
 * `status` is pinned to `"error"` and `errorKind` is non-null. Consumers
 * (e.g., `AuthErrorBanner`) assert this shape once at the render boundary
 * so downstream code doesn't re-check the null.
 */
export type ErroredDatasourceSummary = DatasourceSummary & {
  status: "error";
  errorKind: DatasourceErrorTag;
};

export type CredentialsSchema = "oauth" | "aws-access-key" | "custom";

export interface ProviderCapabilities {
  quota: boolean;
  oauth: boolean;
  directUpload: boolean;
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  icon: string;
  capabilities: ProviderCapabilities;
  credentialsSchema: CredentialsSchema;
}

export const providers = {
  "google-drive": {
    id: "google-drive",
    displayName: "Google Drive",
    icon: "cloud",
    capabilities: { quota: true, oauth: true, directUpload: true },
    credentialsSchema: "oauth",
  },
  onedrive: {
    id: "onedrive",
    displayName: "OneDrive",
    icon: "cloud",
    capabilities: { quota: true, oauth: true, directUpload: true },
    credentialsSchema: "oauth",
  },
  "amazon-s3": {
    id: "amazon-s3",
    displayName: "Amazon S3",
    icon: "database",
    capabilities: { quota: false, oauth: false, directUpload: true },
    credentialsSchema: "aws-access-key",
  },
} as const satisfies Record<string, ProviderDescriptor>;

export type ProviderId = keyof typeof providers;

export type DatasourcesListRequest = void;
export interface DatasourcesListResponse {
  datasources: DatasourceSummary[];
}

export interface DatasourcesAddRequest {
  providerId: string;
  credentials: Record<string, unknown>;
}
export interface DatasourcesAddResponse {
  datasource: DatasourceSummary;
}

export interface DatasourcesRemoveRequest {
  datasourceId: string;
}
export interface DatasourcesRemoveResponse {
  ok: true;
}

export type DatasourceAction = "pause" | "resume" | "sync-now";

export interface DatasourcesActionRequest {
  datasourceId: string;
  action: DatasourceAction;
}
export interface DatasourcesActionResponse {
  datasource: DatasourceSummary;
}

export interface DatasourcesUploadRequest {
  datasourceId: string;
}
export interface DatasourcesUploadResponse {
  transactionId: string;
}
export interface DatasourcesUploadProgressEvent {
  transactionId: string;
  bytesUploaded: number;
  bytesTotal: number;
  status: "uploading" | "completed" | "failed";
  error?: string;
}

// ---------------------------------------------------------------------------
// OAuth consent — added by add-drive-oauth-browser-consent
// ---------------------------------------------------------------------------

/**
 * Request payload for `window.api.datasources.startConsent`. Starts a
 * browser-based OAuth consent session for the given provider. `datasourceId`
 * is OPTIONAL — supplied only for the reconnect path (existing card in the
 * `auth-revoked` / `auth-expired` state) where the id already exists and
 * the main process re-uses it on `consent-completed`. Omit for the add-new
 * path; the main process mints a fresh id on `consent-completed`.
 */
export interface DatasourcesStartConsentRequest {
  providerId: string;
  datasourceId?: string;
}

/**
 * Response payload for `startConsent`. Carries the `sessionId` the
 * renderer uses to filter the `consent-*` event stream down to its own
 * session (the event channel is shared across all active consent
 * sessions in the process). The `sessionId` is an opaque broker-local
 * identifier; it is NOT persisted nor surfaced to the user.
 */
export interface DatasourcesStartConsentResponse {
  sessionId: string;
}

/** Request payload for `window.api.datasources.cancelConsent`. */
export interface DatasourcesCancelConsentRequest {
  sessionId: string;
}

/**
 * Response shape for `cancelConsent`. The handler is fire-and-forget at the
 * contract level — the `consent-cancelled` event on the datasources event
 * stream is the authoritative terminal signal. Idempotent: cancelling a
 * session that is already terminated is a no-op (no error, no duplicate
 * event).
 *
 * At the IPC handler site the method is wrapped in `Promise<void>`; this
 * type names the inner `void` so consumers can `expectTypeOf<...>()
 * .toEqualTypeOf<void>()` against the contract.
 */
export type DatasourcesCancelConsentResponse = void;

/**
 * Discriminated union of consent lifecycle events. Flows through the same
 * `DATASOURCES_CHANNELS.event` stream as the engine's generic
 * `AnyDatasourceEvent` — the preload's `onEvent` callback sees the union
 * of the two (see `DatasourcesStreamEvent`).
 *
 * This union is deliberately FLAT and non-generic: consent is a
 * main-process-owned session that does not belong to any particular
 * datasource type yet (the `datasourceId` is only known on successful
 * completion for the add-new path). Keeping it flat avoids forcing a
 * synthetic `datasourceType` / `payload` envelope onto events that
 * genuinely carry neither.
 *
 * `consent-completed.datasourceId` is REQUIRED — the renderer needs the id
 * to subscribe the new card to engine events.
 * `consent-started.datasourceId` is OPTIONAL — present only on the reconnect
 * path where the id pre-existed.
 */
export type ConsentEvent =
  | {
      event: "consent-started";
      sessionId: string;
      datasourceId?: string;
    }
  | {
      event: "consent-completed";
      sessionId: string;
      datasourceId: string;
    }
  | {
      event: "consent-cancelled";
      sessionId: string;
    }
  | {
      event: "consent-failed";
      sessionId: string;
      tag: DatasourceErrorTag;
      message?: string;
    }
  | {
      event: "consent-timeout";
      sessionId: string;
    };

export const DATASOURCES_CHANNELS = {
  list: "datasources:list",
  add: "datasources:add",
  remove: "datasources:remove",
  action: "datasources:action",
  upload: "datasources:upload",
  uploadProgress: "datasources:upload:progress",
  // One-way main → renderer stream carrying `DatasourceEvent<T, K>` envelopes
  // emitted by the FS Datasource Engine's bus. Wired up by the event bridge
  // in Phase 10 of `openspec/changes/add-fs-datasource-engine`; declared here
  // in Phase 1 so contract consumers can name the channel without reaching
  // into a later-phase file.
  event: "datasources:event",
  // OAuth consent request/response channels (add-drive-oauth-browser-consent).
  // The `consent-*` lifecycle events flow through the existing `event`
  // channel alongside the engine's generic events (see `ConsentEvent`).
  startConsent: "datasources:start-consent",
  cancelConsent: "datasources:cancel-consent",
} as const;
