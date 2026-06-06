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

// migrate-upload-orchestration-out-of-engine §7.5 — `DatasourcesUploadProgressEvent`
// REMOVED. Upload events now flow on `sync:event-stream` keyed by
// service-minted `uploadJobId` (see
// `packages/ipc-contracts/src/sync-service/events.ts` —
// `UploadingPayload` / `FileCreatedPayload` / `UploadFailedPayload` /
// `UploadCancelledPayload`). The `datasources:upload:progress` channel
// + the per-`transactionId`-keyed translation layer in the desktop
// `event-bridge.ts` are both gone (chunk E §13.4). The renderer's
// upload toaster subscribes via `window.api.sync.onEvent` filtered to
// the four upload event kinds.

// `datasources:pick-files-to-upload` is the main-process dialog handler
// the renderer calls to open the native "Open File" multi-select dialog.
// The request carries no fields (the dialog's configuration lives in the
// handler); the response returns the absolute OS paths the user picked,
// or `canceled: true` when the user dismissed the dialog. `filePaths` is
// `readonly` so callers can't mutate the OS-provided list in place.
export type DatasourcesPickFilesRequest = Record<string, never>;
export interface DatasourcesPickFilesResponse {
  filePaths: readonly string[];
  canceled: boolean;
}

// ---------------------------------------------------------------------------
// OAuth consent — RETIRED by `implement-datasource-onboarding`.
//
// The `add-drive-oauth-browser-consent` change shipped a
// main-process-hosted consent broker plus a `startConsent` /
// `cancelConsent` IPC pair plus a `consent-*` event taxonomy on the
// `datasources:event` stream. The `implement-datasource-onboarding`
// change relocates the OAuth loopback HTTP listener into the fs-sync
// service (design.md Decisions 1 + 2) and migrates the renderer's
// authenticate flow onto the service's `sync:authenticate-{start,
// complete,cancel}` commands plus the `auth-*` event taxonomy on the
// `sync:event` stream (design.md Decision 7).
//
// Consequently the entire consent surface — `DatasourcesStartConsent*`,
// `DatasourcesCancelConsent*`, and `ConsentEvent` — is removed from
// the IPC contract surface, along with the `startConsent` /
// `cancelConsent` keys on `DATASOURCES_CHANNELS`.
// ---------------------------------------------------------------------------

export const DATASOURCES_CHANNELS = {
  list: "datasources:list",
  add: "datasources:add",
  remove: "datasources:remove",
  action: "datasources:action",
  // Replaces the retired upload-channel slot (now removed). Opens the
  // native multi-select "Open File" dialog; the renderer then dispatches
  // each picked path through `files.upload`.
  pickFilesToUpload: "datasources:pick-files-to-upload",
  // migrate-upload-orchestration-out-of-engine §7.5 / §13.4 — the
  // `uploadProgress` channel was removed. Upload events now flow on
  // `sync:event-stream` (channel `sync:event`) keyed by `uploadJobId`.
  // One-way main → renderer stream carrying `DatasourceEvent<T, K>` envelopes
  // emitted by the FS Datasource Engine's bus. Wired up by the event bridge
  // in Phase 10 of `openspec/changes/add-fs-datasource-engine`; declared here
  // in Phase 1 so contract consumers can name the channel without reaching
  // into a later-phase file. The `consent-*` event family that previously
  // flowed alongside the engine's events on this channel was retired by
  // `implement-datasource-onboarding`; authenticate lifecycle events now
  // flow as `auth-*` on the service's `sync:event` stream.
  event: "datasources:event",
} as const;
