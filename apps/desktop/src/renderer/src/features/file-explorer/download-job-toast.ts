"use client";

//
// add-engine-rename-download §24 — per-job Sonner download toaster.
//
// Per design.md Decision 8 the download toast is decoupled from the
// orchestrator: every download lifecycle event arrives on a single
// global stream (`window.api.sync.onEvent` filtered to the four
// download lifecycle event names), and the toaster spawns one Sonner
// toast per previously-unseen `downloadJobId`. Subsequent events for
// the same id update the toast in place.
//
// This decoupling means the orchestrator's `dispatchDownload` does NOT
// hand the toaster a jobId at click-time — there is no `downloadJobId`
// on `FilesDownloadResponse`. Instead the toaster owns its own spawn-
// tracker (`Map<downloadJobId, ToastEntry>`), which it consults on every
// event:
//   - first event for an unseen id → spawn loading toast + record
//     `(toastId, basename)`
//   - subsequent `downloading` events → update existing toast id with
//     the new progress percentage
//   - terminal `file-downloaded` → flip via `toast.custom()` to the V2
//     dual-action success layout (Show in folder + Open)
//   - terminal `download-failed` → red `toast.error` with `richColors`
//     and a Retry action
//   - terminal `download-cancelled` → silent `toast.dismiss`
//
// App-launch hydration uses the same spawn path. `hydrateActiveDownloads`
// pre-seeds the spawn-tracker with one toast per `DownloadJobSummary`
// (the `bytesDownloaded`/`contentLength` ratio drives the initial
// percentage); the next live event for any of those ids updates the
// existing toast rather than creating a duplicate.

import { toast as sonnerToast } from "sonner";

// --- Public types ----------------------------------------------------

// Local event union mirroring `EventPayloadMap` from
// `@ft5/ipc-contracts/sync-service` for the four download lifecycle
// kinds. Inlined here rather than imported because the sync-service
// subpath is forbidden from the renderer barrier (see preload's
// import-boundary test). Structural shape is identical to the wire
// contract.
export type DownloadEvent =
  | {
      readonly kind: "downloading";
      readonly payload: {
        readonly downloadJobId: string;
        readonly datasourceId: string;
        readonly progress: number;
        readonly path: string;
      };
    }
  | {
      readonly kind: "file-downloaded";
      readonly payload: {
        readonly downloadJobId: string;
        readonly datasourceId: string;
        readonly savedPath: string;
        readonly bytes: number;
      };
    }
  | {
      readonly kind: "download-failed";
      readonly payload: {
        readonly downloadJobId: string;
        readonly datasourceId: string;
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
      readonly kind: "download-cancelled";
      readonly payload: {
        readonly downloadJobId: string;
        readonly datasourceId: string;
        readonly bytesDownloaded: number;
        readonly bytesTotal: number | null;
        readonly reason: "user";
      };
    };

export type DownloadEventKind = DownloadEvent["kind"];

const DOWNLOAD_EVENT_KINDS: ReadonlySet<DownloadEventKind> = new Set([
  "downloading",
  "file-downloaded",
  "download-failed",
  "download-cancelled",
]);

/**
 * Local mirror of `DownloadJob` from the sync-service wire surface.
 * Structurally identical; mirrored here for the same reason as
 * `DownloadEvent` (the sync-service subpath is forbidden from the
 * renderer barrier).
 */
export interface DownloadJobSummary {
  readonly downloadJobId: string;
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly bytesDownloaded: number;
  readonly contentLength: number | null;
  readonly startedAt: number;
}

/** Subset of Sonner's `toast` callable shape used by the toaster. */
export interface ToastApi {
  loading(
    message: string,
    opts?: { id?: string | number; duration?: number },
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
      richColors?: boolean;
      action?: { label: string; onClick: () => void };
    },
  ): string | number;
  custom(
    render: (id: string | number) => unknown,
    opts?: {
      id?: string | number;
      duration?: number;
      // Test-only ergonomics: the actions map is surfaced on the
      // options bag so consumers can verify wiring without rendering
      // the React tree. Sonner ignores unknown options.
      actions?: {
        onOpen: () => void;
        onShowInFolder: () => void;
      };
    },
  ): string | number;
  dismiss(id: string | number): void;
}

/**
 * Subscription port. The factory hands the callback to whichever event
 * stream the host wires up. In production this is
 * `window.api.sync.onEvent` filtered to the four download kinds;
 * tests inject a stub that calls back synchronously.
 */
export interface DownloadEventApi {
  onDownloadEvent(callback: (event: DownloadEvent) => void): () => void;
}

/**
 * Optional per-event side-effect bridge. The success-toast's actions
 * route through `window.api.files.{openSavedPath,showSavedInFolder}` in
 * production; tests inject a stub.
 */
export interface FilesActionsApi {
  openSavedPath(savedPath: string): Promise<void>;
  showSavedInFolder(savedPath: string): Promise<void>;
}

export interface DownloadToasterDeps {
  readonly toast?: ToastApi;
  readonly eventApi?: DownloadEventApi;
  readonly filesApi?: FilesActionsApi;
}

export interface DownloadToaster {
  /**
   * Pre-seed the spawn-tracker with one toast per active download
   * returned by `downloads:list-active`. Called from the file-explorer's
   * `useEffect(... onActiveDownloadsHydrate)`.
   */
  hydrateActiveDownloads(jobs: readonly DownloadJobSummary[]): void;
  /**
   * Register a retry callback keyed by `(datasourceId, sourcePath)`.
   * The orchestrator calls this just before dispatching
   * `window.api.files.download(...)` so the toaster can correlate the
   * first `downloading` event back to a callable that re-runs the
   * dispatch with the original args. On the toast's first
   * `downloading` event for a previously-unseen `downloadJobId`, the
   * toaster looks up the (datasourceId, payload.path) pair, attaches
   * the callback to the toast entry, and removes it from the registry.
   * If the download fails before any `downloading` event arrives (rare
   * — instant auth-revoked / other), the failure toast falls back to
   * dismiss-only because the correlation never happened.
   */
  registerRetry(
    datasourceId: string,
    sourcePath: string,
    retry: () => void,
  ): void;
  /** Tear down the event subscription. Most callers don't need this — the renderer's lifetime is the app's lifetime — but it's exposed for completeness + tests. */
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
    custom: (render, opts) =>
      sonnerToast.custom(
        render as (id: string | number) => React.ReactElement,
        opts,
      ) as string | number,
    dismiss: (id) => {
      sonnerToast.dismiss(id);
    },
  };
}

function resolveEventApi(
  injected: DownloadEventApi | undefined,
): DownloadEventApi {
  if (injected) return injected;
  // Production fallback: subscribe to `window.api.sync.onEvent` and
  // filter to the four download kinds. The renderer-facing `SyncEvent`
  // type does NOT enumerate the download kinds (the
  // `sync-service-desktop` re-export omits them), but the main-process
  // `event-bridge` forwards every service event to the renderer
  // verbatim — the runtime payload includes the four download events
  // regardless. Cast through `unknown` accordingly.
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
    throw new Error(
      "createDownloadJobToaster: no eventApi provided and window.api.sync.onEvent is unavailable",
    );
  }
  return {
    onDownloadEvent(callback) {
      const unsubscribe = bridge((event) => {
        if (
          DOWNLOAD_EVENT_KINDS.has(event.kind as DownloadEventKind)
        ) {
          callback(event as DownloadEvent);
        }
      });
      return unsubscribe;
    },
  };
}

function resolveFilesApi(
  injected: FilesActionsApi | undefined,
): FilesActionsApi {
  if (injected) return injected;
  const bridge = (
    globalThis as unknown as {
      window?: {
        api?: {
          files?: {
            openSavedPath?: (savedPath: string) => Promise<void>;
            showSavedInFolder?: (savedPath: string) => Promise<void>;
          };
        };
      };
    }
  ).window?.api?.files;
  // Lazy fallback — return no-ops if the bridge isn't wired (e.g. the
  // renderer test harness without the preload). Throwing here would
  // hard-crash the toaster on every event subscription, which is too
  // strict; the success-action click is the only place the bridge is
  // strictly needed and that's user-driven.
  return {
    openSavedPath: bridge?.openSavedPath ?? (async () => {}),
    showSavedInFolder: bridge?.showSavedInFolder ?? (async () => {}),
  };
}

// --- Helpers ---------------------------------------------------------

function basenameFromPath(path: string): string {
  // Datasource paths are POSIX — split on `/`. Defensive against a
  // trailing slash (folders never appear in download events; this is
  // belt-and-braces).
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

function formatProgressMessage(
  basename: string,
  progressPct: number,
): string {
  const clamped = Math.max(0, Math.min(100, Math.round(progressPct)));
  return `Downloading ${basename} — ${clamped}%`;
}

function formatSeededRatio(
  bytesDownloaded: number,
  contentLength: number | null,
): number {
  if (contentLength === null || contentLength <= 0) return 0;
  return Math.round((100 * bytesDownloaded) / contentLength);
}

// --- Implementation --------------------------------------------------

interface ToastEntry {
  readonly toastId: string | number;
  readonly basename: string;
  /**
   * Retry callback correlated from the orchestrator's pre-dispatch
   * `registerRetry(...)` on the FIRST `downloading` event for a new
   * `downloadJobId`. Wired into the failure-toast's Retry button.
   * Undefined when correlation hasn't happened yet (e.g. terminal-as-
   * first-event paths, hydrated-from-disk jobs, or downloads not
   * dispatched through this renderer's orchestrator).
   */
  readonly retry?: () => void;
}

/**
 * Composite key for the orchestrator's pre-dispatch `registerRetry`.
 * `datasourceId|sourcePath` is sufficient because the renderer never
 * dispatches two simultaneous downloads for the same source on the
 * same datasource (the second would race the first's IPC, and even if
 * it did, both would correctly retry the same source).
 */
function retryKey(datasourceId: string, sourcePath: string): string {
  return `${datasourceId}|${sourcePath}`;
}

export function createDownloadJobToaster(
  deps?: DownloadToasterDeps,
): DownloadToaster {
  const toast: ToastApi = deps?.toast ?? sonnerAdapter();
  const eventApi = resolveEventApi(deps?.eventApi);
  const filesApi = resolveFilesApi(deps?.filesApi);

  // Per-job tracker: maps the consumer-facing `downloadJobId` to the
  // Sonner toast id we minted on first sight + the basename we display
  // (cached so terminal events that don't carry a path still know the
  // human label).
  const tracker = new Map<string, ToastEntry>();
  // Pre-dispatch retry registry. Keyed on `(datasourceId, sourcePath)`
  // because that pair is what the orchestrator knows BEFORE the first
  // `downloading` event yields a `downloadJobId`. Drained into the
  // ToastEntry on first event for a previously-unseen jobId.
  const pendingRetries = new Map<string, () => void>();
  let nextLocalId = 1;
  function generateToastId(): string {
    const n = nextLocalId;
    nextLocalId += 1;
    return `download-toast-${n}`;
  }

  function handleEvent(event: DownloadEvent): void {
    const downloadJobId = event.payload.downloadJobId;

    if (event.kind === "downloading") {
      const basename = basenameFromPath(event.payload.path);
      const existing = tracker.get(downloadJobId);
      if (existing) {
        // Update in place.
        toast.loading(
          formatProgressMessage(existing.basename, event.payload.progress),
          { id: existing.toastId },
        );
      } else {
        // Spawn new toast for this jobId. If the orchestrator pre-
        // registered a retry callback for `(datasourceId, sourcePath)`,
        // drain it into the ToastEntry and remove the registry slot
        // (the pairing is one-shot per dispatch).
        const initialId = generateToastId();
        const toastId = toast.loading(
          formatProgressMessage(basename, event.payload.progress),
          { id: initialId },
        );
        const key = retryKey(event.payload.datasourceId, event.payload.path);
        const retry = pendingRetries.get(key);
        if (retry !== undefined) {
          pendingRetries.delete(key);
        }
        tracker.set(downloadJobId, { toastId, basename, retry });
      }
      return;
    }

    if (event.kind === "file-downloaded") {
      const existing = tracker.get(downloadJobId);
      const basename =
        existing?.basename ?? basenameFromPath(event.payload.savedPath);
      // No prior loading toast — first event for this id is terminal.
      // Mint a custom-toast id so the success render addresses
      // something stable. Spawn-and-immediately-flip per design.md
      // Decision 8.
      const toastId =
        existing?.toastId ?? generateToastId();
      tracker.set(downloadJobId, { toastId, basename });
      const savedPath = event.payload.savedPath;
      const onOpen = () => {
        void filesApi.openSavedPath(savedPath);
        toast.dismiss(toastId);
      };
      const onShowInFolder = () => {
        void filesApi.showSavedInFolder(savedPath);
        toast.dismiss(toastId);
      };
      // Post-archive smoke (2026-04-28) — explicit dismiss-then-spawn:
      // simply re-using the same toast id with `toast.custom(..., { id })`
      // does NOT clear Sonner's loading-variant chrome (the spinner is
      // part of Sonner's `toast.loading` template, not our custom render).
      // Without the dismiss, the success render mounts but the original
      // loading toast's spinner persists in the DOM. Dismissing first
      // forces Sonner to tear down the loading chrome before the custom
      // render mounts, so the user sees only the success layout.
      if (existing !== undefined) {
        toast.dismiss(toastId);
      }
      toast.custom(
        (id) => buildSuccessRender(id, basename, onOpen, onShowInFolder),
        {
          id: toastId,
          duration: 4000,
          actions: { onOpen, onShowInFolder },
        },
      );
      // Drop from tracker — terminal events are one-shot.
      tracker.delete(downloadJobId);
      return;
    }

    if (event.kind === "download-failed") {
      const existing = tracker.get(downloadJobId);
      const basename = existing?.basename ?? "download";
      const toastId = existing?.toastId ?? generateToastId();
      // Retry callback was correlated on the FIRST `downloading` event
      // for this jobId (drained from `pendingRetries` into the
      // ToastEntry). If failure preceded any `downloading` event (rare
      // — instant auth-revoked / immediate validation reject), no
      // correlation happened and Retry falls back to dismiss-only.
      const retry = existing?.retry;
      tracker.set(downloadJobId, { toastId, basename, retry });
      toast.error(`Download failed: ${event.payload.message}`, {
        id: toastId,
        duration: Number.POSITIVE_INFINITY,
        richColors: true,
        action: {
          label: "Retry",
          onClick: () => {
            toast.dismiss(toastId);
            if (retry !== undefined) {
              retry();
            }
          },
        },
      });
      tracker.delete(downloadJobId);
      return;
    }

    if (event.kind === "download-cancelled") {
      const existing = tracker.get(downloadJobId);
      if (existing) {
        toast.dismiss(existing.toastId);
        tracker.delete(downloadJobId);
      }
      return;
    }
  }

  const unsubscribe = eventApi.onDownloadEvent(handleEvent);

  function hydrateActiveDownloads(
    jobs: readonly DownloadJobSummary[],
  ): void {
    for (const job of jobs) {
      // Skip if the live event stream beat us to this id (first
      // `downloading` event arrived before hydration ran). Defensive
      // — in practice main fires `onActiveDownloadsHydrate` once on
      // first connect before any live event reaches the renderer.
      if (tracker.has(job.downloadJobId)) continue;
      const basename = basenameFromPath(job.sourcePath);
      const initialPct = formatSeededRatio(
        job.bytesDownloaded,
        job.contentLength,
      );
      const initialId = generateToastId();
      const toastId = toast.loading(
        formatProgressMessage(basename, initialPct),
        { id: initialId },
      );
      tracker.set(job.downloadJobId, { toastId, basename });
    }
  }

  function registerRetry(
    datasourceId: string,
    sourcePath: string,
    retry: () => void,
  ): void {
    pendingRetries.set(retryKey(datasourceId, sourcePath), retry);
  }

  return {
    hydrateActiveDownloads,
    registerRetry,
    dispose: () => {
      unsubscribe();
      tracker.clear();
      pendingRetries.clear();
    },
  };
}

// --- Success-toast render --------------------------------------------

// V2 design.md Decision: Sonner `toast.custom()` rendering with the
// dual-action layout. The render function receives the toast id; we use
// it for ARIA / styling hooks only — the actual close happens through
// `toast.dismiss(toastId)` already wired into the action handlers.
//
// The render runs inside React (Sonner mounts the returned ReactElement
// into the toast viewport). We import React at module scope so the
// helper is type-correct without dragging the JSX runtime into the
// node-side test environment when the render isn't invoked.
import * as React from "react";

function buildSuccessRender(
  _id: string | number,
  basename: string,
  onOpen: () => void,
  onShowInFolder: () => void,
): React.ReactElement {
  // Hand-written React.createElement tree (no JSX) so this module's
  // node-style tests don't need a JSX-aware transform. The shape
  // mirrors design.md V2:
  //   ┌──────────────────────────────────────────┐
  //   │ ✓ Downloaded <basename>                  │
  //   │      Show in folder       [    Open    ] │
  //   └──────────────────────────────────────────┘
  return React.createElement(
    "div",
    {
      className:
        "bg-popover text-popover-foreground flex flex-col gap-3 rounded-md border p-4 shadow-md",
      role: "status",
    },
    React.createElement(
      "div",
      { className: "text-sm font-medium" },
      `✓ Downloaded ${basename}`,
    ),
    React.createElement(
      "div",
      {
        className: "flex items-center justify-end gap-3",
      },
      React.createElement(
        "button",
        {
          type: "button",
          onClick: onShowInFolder,
          className:
            "text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline",
        },
        "Show in folder",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          onClick: onOpen,
          className:
            "bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center justify-center rounded-md px-3 text-sm font-medium",
        },
        "Open",
      ),
    ),
  );
}
