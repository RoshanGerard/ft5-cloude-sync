// migrate-upload-orchestration-out-of-engine §14.2 / §14.5 — per-job
// Sonner upload toaster post chunk-D direct-RPC cutover.
//
// `createUploadJobToaster` subscribes ONCE to a unified
// `sync:event-stream` (filtered to the four upload event kinds
// `uploading`/`file-created`/`upload-failed`/`upload-cancelled`) and
// fans events to per-`uploadJobId` toasts. Mirrors
// `download-job-toast.ts` in shape but retains the orchestrator-driven
// `onJobDispatched(jobId, basename, retry)` entry point so the
// dispatch-time renderer wiring stays unchanged.
//
// Spawn paths:
//   1. Orchestrator dispatch (`onJobDispatched`) — primary path. Mounts
//      a loading toast keyed on the service-minted `uploadJobId` and
//      records the basename + retry callback in the per-job tracker.
//   2. App-launch hydrate (`hydrateActiveUploads`) — for each in-flight
//      upload returned by `uploads:list-active`, mount a loading toast
//      at the seeded percentage. Live events for those ids then update
//      the existing toast rather than spawning a duplicate.
//
// Pre-migration the toaster subscribed to
// `window.api.datasources.onUploadProgress(transactionId, ...)` —
// per-dispatch subscriptions, transactionId-keyed events translated
// from the engine's `job-progress` events by the desktop event-bridge.
// Post-migration the engine no longer emits upload events; the
// fs-sync handler is the SOLE emitter (see
// services/fs-sync/src/commands/files-upload.ts) and events flow on
// `sync:event-stream` keyed by `uploadJobId`. Eliminates the legacy
// translation layer entirely.
//
// Cancel action: Sonner's `toast.loading(...)` accepts an `action` opt;
// the toaster wires it to `syncApi.cancelUpload({ uploadJobId })`. Per
// the design this is fire-and-forget — the user-visible signal is the
// subsequent `upload-cancelled` event arriving on the bus, which the
// `upload-cancelled` handler dismisses with `toast.dismiss`.

import { toast as sonnerToast } from "sonner";

import type { UploadToaster } from "./use-upload-orchestrator";

// --- Public types ----------------------------------------------------

// Local mirror of the four upload-event payloads from
// `@ft5/ipc-contracts/sync-service`. Inlined here rather than imported
// because the sync-service subpath is forbidden from the renderer
// barrier (see preload's import-boundary test). Structural shape is
// identical to the wire contract.
export type UploadEvent =
  | {
      readonly kind: "uploading";
      readonly payload: {
        readonly uploadJobId: string;
        readonly datasourceId: string;
        readonly sourcePath: string;
        readonly targetPath: string;
        readonly bytesUploaded: number;
        readonly bytesTotal: number | null;
      };
    }
  | {
      readonly kind: "file-created";
      readonly payload: {
        readonly uploadJobId: string;
        readonly datasourceId: string;
        readonly targetPath: string;
        readonly handle: string;
      };
    }
  | {
      readonly kind: "upload-failed";
      readonly payload: {
        readonly uploadJobId: string;
        readonly datasourceId: string;
        readonly targetPath: string;
        readonly tag:
          | "auth-revoked"
          | "disconnected"
          | "rate-limited"
          | "other"
          | "invalid-datasource";
        readonly message: string;
      };
    }
  | {
      readonly kind: "upload-cancelled";
      readonly payload: {
        readonly uploadJobId: string;
        readonly datasourceId: string;
        readonly sourcePath: string;
        readonly targetPath: string;
        readonly bytesUploaded: number;
        readonly bytesTotal: number | null;
        readonly reason: "user";
      };
    };

export type UploadEventKind = UploadEvent["kind"];

const UPLOAD_EVENT_KINDS: ReadonlySet<UploadEventKind> = new Set<UploadEventKind>([
  "uploading",
  "file-created",
  "upload-failed",
  "upload-cancelled",
]);

/**
 * Local mirror of `UploadJob` from the sync-service wire surface.
 * Structurally identical; mirrored here for the same reason as
 * `UploadEvent` (the sync-service subpath is forbidden from the
 * renderer barrier).
 */
export interface UploadJobSummary {
  readonly uploadJobId: string;
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly bytesUploaded: number;
  readonly contentLength: number | null;
  readonly startedAt: number;
}

/** Subset of Sonner's `toast` callable shape used by the toaster. */
export interface ToastApi {
  loading(
    message: string,
    opts?: {
      id?: string | number;
      duration?: number;
      action?: { label: string; onClick: () => void };
    },
  ): string | number;
  success(
    message: string,
    opts?: { id?: string | number; duration?: number },
  ): string | number;
  error(
    message: string,
    opts?: {
      id?: string | number;
      duration?: number;
      action?: { label: string; onClick: () => void };
      // Sonner's per-toast richColors override.
      richColors?: boolean;
    },
  ): string | number;
  dismiss(id: string | number): void;
}

/**
 * Subscription port. The factory hands the callback to whichever event
 * stream the host wires up. In production this is
 * `window.api.sync.onEvent` filtered to the four upload kinds; tests
 * inject a stub that calls back synchronously.
 */
export interface UploadEventApi {
  onUploadEvent(callback: (event: UploadEvent) => void): () => void;
}

/**
 * Cancel action bridge — invoked by the Cancel button on an in-flight
 * loading toast. Production resolves to
 * `window.api.sync.cancelUpload({ uploadJobId })`; tests inject a stub.
 * Fire-and-forget — the toaster does NOT await the Promise; the
 * user-visible signal is the subsequent `upload-cancelled` event
 * arriving on the bus.
 */
export interface SyncActionsApi {
  cancelUpload(req: { uploadJobId: string }): Promise<unknown>;
}

export interface UploadToasterDeps {
  readonly toast?: ToastApi;
  readonly eventApi?: UploadEventApi;
  readonly syncApi?: SyncActionsApi;
  /**
   * Optional per-job-completed callback. Fires when a `file-created`
   * event arrives for any dispatched job, BEFORE the per-job tracker
   * entry is finalised. The file-explorer wires this to
   * `store.retryLoad()` so the entries list refreshes once the provider
   * has acknowledged the new file (Bug 2 fix). Failed / cancelled
   * uploads do not trigger this callback.
   */
  readonly onJobCompleted?: (uploadJobId: string) => void;
}

export interface UploadJobToaster extends UploadToaster {
  /**
   * Pre-seed the per-job tracker with one toast per active upload
   * returned by `uploads:list-active`. Called from the file-explorer's
   * `useEffect(... onActiveUploadsHydrate)`. Mirrors the download
   * toaster's `hydrateActiveDownloads`.
   */
  hydrateActiveUploads(jobs: readonly UploadJobSummary[]): void;
  /** Tear down the upload-event subscription. */
  dispose(): void;
}

// --- Production fallbacks --------------------------------------------

function sonnerAdapter(): ToastApi {
  return {
    loading: (message, opts) =>
      sonnerToast.loading(message, opts) as string | number,
    success: (message, opts) =>
      sonnerToast.success(message, opts) as string | number,
    error: (message, opts) =>
      sonnerToast.error(message, opts) as string | number,
    dismiss: (id) => {
      sonnerToast.dismiss(id);
    },
  };
}

function resolveEventApi(
  injected: UploadEventApi | undefined,
): UploadEventApi {
  if (injected) return injected;
  // Production fallback: subscribe to `window.api.sync.onEvent` and
  // filter to the four upload kinds. The renderer-facing `SyncEvent`
  // type does NOT enumerate the upload kinds (the
  // `sync-service-desktop` re-export omits them), but the main-process
  // `event-bridge` forwards every service event to the renderer
  // verbatim — the runtime payload includes the four upload events
  // regardless. Cast through `unknown` accordingly. Same pattern as
  // download-job-toast.ts's `resolveEventApi`.
  //
  // Test-harness fallback: when `window.api.sync.onEvent` is not
  // available (e.g. node-style unit tests for the dashboard's
  // `<DatasourceCard>` and `<FileExplorer>` mounted without the
  // preload), return a no-op subscription. The toaster constructs
  // safely, no listener is registered, and no events are routed. This
  // is the right choice for two reasons: (1) the toaster is the only
  // pre-mounted dependency on `window.api.sync.onEvent`, and tests
  // that don't install the preload also don't fire upload events, so
  // a no-op is functionally equivalent to a wired-up subscription
  // that never receives anything; (2) throwing here would force every
  // mounted test that uses the dashboard / explorer (and there are
  // many) to install a stub, which masks unrelated test concerns.
  // Mirrors the lazy-fallback pattern in
  // `useDownloadOrchestrator.resolveApi`.
  type LooseEvent = { kind: string; payload: unknown };
  const bridge = (
    globalThis as unknown as {
      window?: {
        api?: {
          sync?: {
            onEvent?: (
              cb: (event: LooseEvent) => void,
            ) => () => void;
          };
        };
      };
    }
  ).window?.api?.sync?.onEvent;
  if (typeof bridge !== "function") {
    return { onUploadEvent: () => () => {} };
  }
  return {
    onUploadEvent(callback) {
      const unsubscribe = bridge((event) => {
        if (UPLOAD_EVENT_KINDS.has(event.kind as UploadEventKind)) {
          callback(event as UploadEvent);
        }
      });
      return unsubscribe;
    },
  };
}

function resolveSyncApi(
  injected: SyncActionsApi | undefined,
): SyncActionsApi {
  if (injected) return injected;
  // Production fallback: pull from the preload bridge. Lazy resolution —
  // we look up `window.api.sync.cancelUpload` at click time so the
  // toaster can mount safely in test harnesses without the preload
  // (e.g. node-style tests for unrelated code paths). Throwing at the
  // click site keeps the failure mode diagnosable; non-throwing here
  // would silently swallow user clicks. Same pattern as
  // download-job-toast's resolveSyncApi.
  type CancelFn = (req: { uploadJobId: string }) => Promise<unknown>;
  return {
    async cancelUpload(req) {
      const fn = (
        globalThis as unknown as {
          window?: {
            api?: {
              sync?: { cancelUpload?: CancelFn };
            };
          };
        }
      ).window?.api?.sync?.cancelUpload;
      if (typeof fn !== "function") {
        throw new Error(
          "createUploadJobToaster: window.api.sync.cancelUpload is unavailable",
        );
      }
      return fn(req);
    },
  };
}

// --- Helpers ---------------------------------------------------------

function basenameFromPath(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

function formatProgressMessage(
  basename: string,
  bytesUploaded: number,
  bytesTotal: number | null,
): string {
  if (bytesTotal !== null && bytesTotal > 0) {
    const pct = Math.max(
      0,
      Math.min(100, Math.round((100 * bytesUploaded) / bytesTotal)),
    );
    return `Uploading ${basename} — ${pct}%`;
  }
  return `Uploading ${basename}…`;
}

function formatSeededRatio(
  bytesUploaded: number,
  contentLength: number | null,
): { bytesUploaded: number; bytesTotal: number | null } {
  return { bytesUploaded, bytesTotal: contentLength };
}

// --- Implementation --------------------------------------------------

interface ToastEntry {
  readonly toastId: string | number;
  readonly basename: string;
  readonly retry?: () => Promise<void>;
  /** Marker set on terminal events (success/failure/cancel). */
  readonly terminal?: boolean;
}

export function createUploadJobToaster(
  deps?: UploadToasterDeps,
): UploadJobToaster {
  const toast: ToastApi = deps?.toast ?? sonnerAdapter();
  const eventApi = resolveEventApi(deps?.eventApi);
  const syncApi = resolveSyncApi(deps?.syncApi);

  // Per-uploadJobId tracker.
  const tracker = new Map<string, ToastEntry>();
  let nextLocalId = 1;
  function generateToastId(): string {
    const n = nextLocalId;
    nextLocalId += 1;
    return `upload-toast-${n}`;
  }

  function buildCancelAction(uploadJobId: string): {
    label: string;
    onClick: () => void;
  } {
    return {
      label: "Cancel",
      onClick: () => {
        // Fire-and-forget; the user-visible signal is the subsequent
        // `upload-cancelled` event. Errors at the IPC layer surface as
        // unhandled rejections on the console — production callers
        // always have the bridge wired, so this only matters for
        // harness misconfigurations. Mirrors download-job-toast.ts's
        // buildCancelAction.
        void syncApi.cancelUpload({ uploadJobId });
      },
    };
  }

  function handleEvent(event: UploadEvent): void {
    const uploadJobId = event.payload.uploadJobId;
    const existing = tracker.get(uploadJobId);

    if (event.kind === "uploading") {
      const basename =
        existing?.basename ?? basenameFromPath(event.payload.targetPath);
      if (existing) {
        toast.loading(
          formatProgressMessage(
            basename,
            event.payload.bytesUploaded,
            event.payload.bytesTotal,
          ),
          {
            id: existing.toastId,
            action: buildCancelAction(uploadJobId),
          },
        );
      } else {
        // First event for an uploadJobId we haven't seen yet (e.g.
        // hydrate didn't catch it OR the orchestrator's
        // onJobDispatched ran out of order). Spawn a fresh toast.
        const initialId = generateToastId();
        const toastId = toast.loading(
          formatProgressMessage(
            basename,
            event.payload.bytesUploaded,
            event.payload.bytesTotal,
          ),
          {
            id: initialId,
            action: buildCancelAction(uploadJobId),
          },
        );
        tracker.set(uploadJobId, { toastId, basename });
      }
      return;
    }

    if (event.kind === "file-created") {
      // Duplicate-terminal guard: if this id has already received a
      // terminal event, do not re-render. (Defensive — see download
      // toaster's `terminal` docstring for the race window.)
      if (existing?.terminal === true) return;
      const basename =
        existing?.basename ?? basenameFromPath(event.payload.targetPath);
      const toastId = existing?.toastId ?? generateToastId();
      toast.success(`Uploaded ${basename}`, {
        id: toastId,
        duration: 4000,
      });
      tracker.set(uploadJobId, { toastId, basename, terminal: true });
      deps?.onJobCompleted?.(uploadJobId);
      return;
    }

    if (event.kind === "upload-failed") {
      if (existing?.terminal === true) return;
      const basename =
        existing?.basename ?? basenameFromPath(event.payload.targetPath);
      const retry = existing?.retry;
      const toastId = existing?.toastId ?? generateToastId();
      const reason = event.payload.message
        ? `Upload failed (${event.payload.tag}): ${basename}`
        : `Upload failed: ${basename}`;
      toast.error(reason, {
        id: toastId,
        duration: Number.POSITIVE_INFINITY,
        // Per-toast richColors override — the global Toaster runs
        // without richColors so neutral toasts use the project's
        // --popover surface; the override gives THIS toast the red
        // treatment without changing every error toast app-wide.
        // Same pattern as the legacy upload toaster + download
        // failure toast.
        richColors: true,
        action: {
          label: "Retry",
          onClick: () => {
            // Dismiss the OLD toast; the orchestrator's `retry()`
            // closure re-runs the dispatch which fires
            // `onJobDispatched(newUploadJobId)` and spawns a fresh
            // toast bound to the new id. Same pattern as the legacy
            // upload toaster (test (e) in upload-job-toast.test.ts).
            toast.dismiss(toastId);
            if (retry !== undefined) {
              void retry();
            }
          },
        },
      });
      tracker.set(uploadJobId, {
        toastId,
        basename,
        retry,
        terminal: true,
      });
      return;
    }

    if (event.kind === "upload-cancelled") {
      if (existing) {
        toast.dismiss(existing.toastId);
        tracker.delete(uploadJobId);
      }
      return;
    }
  }

  const unsubscribe = eventApi.onUploadEvent(handleEvent);

  function onJobDispatched(args: {
    jobId: string;
    basename: string;
    retry: () => Promise<void>;
  }): void {
    // If we already saw an event for this id (rare race — e.g. the
    // service emitted the initial `uploading 0%` before the dispatch
    // response landed in the renderer), don't double-mount. Update the
    // tracker's `retry` so the failure-toast Retry button works.
    const existing = tracker.get(args.jobId);
    if (existing) {
      tracker.set(args.jobId, { ...existing, retry: args.retry });
      return;
    }
    const initialId = generateToastId();
    const toastId = toast.loading(`Uploading ${args.basename}…`, {
      id: initialId,
      action: buildCancelAction(args.jobId),
    });
    tracker.set(args.jobId, {
      toastId,
      basename: args.basename,
      retry: args.retry,
    });
  }

  function onBatchError(message: string): void {
    toast.error(message);
  }

  function hydrateActiveUploads(jobs: readonly UploadJobSummary[]): void {
    for (const job of jobs) {
      // Skip if a live event already spawned a toast for this id.
      if (tracker.has(job.uploadJobId)) continue;
      const basename = basenameFromPath(job.targetPath);
      const seed = formatSeededRatio(job.bytesUploaded, job.contentLength);
      const initialId = generateToastId();
      const toastId = toast.loading(
        formatProgressMessage(basename, seed.bytesUploaded, seed.bytesTotal),
        {
          id: initialId,
          action: buildCancelAction(job.uploadJobId),
        },
      );
      tracker.set(job.uploadJobId, { toastId, basename });
    }
  }

  return {
    onJobDispatched,
    onBatchError,
    hydrateActiveUploads,
    dispose: () => {
      unsubscribe();
      tracker.clear();
    },
  };
}
