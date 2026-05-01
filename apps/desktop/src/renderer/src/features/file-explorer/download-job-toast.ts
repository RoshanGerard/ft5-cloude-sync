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
//     the new progress percentage (description cleared)
//   - `download-retrying` → reissue `toast.loading` on the same id with
//     a "Reconnecting (attempt/limit)" message and the diagnostic
//     context (`engineCause`, `waitMs`) as Sonner's `description` field
//     (see add-download-resilience §11.16 / Decision 5 v2)
//   - terminal `file-downloaded` → flip via `toast.custom()` to the V2
//     dual-action success layout (Show in folder + Open)
//   - terminal `download-failed` → red `toast.error` with `richColors`
//     and a Retry action (description cleared so prior retrying-state
//     diagnostic doesn't carry over via Sonner's merge)
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
        // §12.3 (Decision 14) — bytes-only progress fallback. The
        // renderer formats `<X>%` when bytesTotal !== null && > 0;
        // otherwise it falls back to `<bytesLoaded MB>` (or GB at
        // 1 GB+ scale). bytesLoaded is the engine's byte-counting
        // Transform's running count; bytesTotal mirrors the
        // engine response's contentLength literally (null when the
        // provider's Content-Length header is absent / empty).
        readonly bytesLoaded: number;
        readonly bytesTotal: number | null;
      };
    }
  | {
      readonly kind: "download-retrying";
      readonly payload: {
        readonly downloadJobId: string;
        readonly datasourceId: string;
        readonly attempt: number;
        readonly limit: number;
        readonly waitMs: number;
        // `engineCause` is the engine-side `DatasourceErrorTag` verbatim
        // (a deliberate engine-taxonomy leak, scoped to diagnostic
        // decoration only — see add-download-resilience design.md
        // Decision 9). Kept as `string` here because the renderer SHALL
        // NOT branch on its value; widening to `string` keeps the wire
        // contract stable while preventing accidental switch / match
        // patterns from the renderer side.
        readonly engineCause: string;
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
          // add-download-resilience §1: terminal tag for both
          // count-exhaustion and walltime-exhaustion. The discriminator
          // ("which budget exhausted") lives in the message field.
          | "exhausted-retries"
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
  "download-retrying",
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
    opts?: {
      id?: string | number;
      duration?: number;
      // §11.16 (iter-3): retrying state surfaces `engineCause` + `waitMs`
      // diagnostic context as Sonner's `description` field. Required on
      // the resume-from-retrying path too — passed as `""` (falsy) to
      // clear the prior retrying-state description from Sonner's
      // `Observer.create()` merge (otherwise the diagnostic text lingers
      // on the resumed downloading toast). See Decision 5 v2.
      description?: string;
      // §12.2 (Decision 13): active download toast renders a Cancel
      // action button via Sonner's built-in `action` option. Sonner
      // renders `toast.action` on the loading template (line 812-824
      // of `node_modules/sonner/dist/index.mjs`). The toaster wires
      // `onClick` to call `syncApi.cancelJob({ downloadJobId })` —
      // see the `download-retrying` and `downloading` handlers below.
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
      richColors?: boolean;
      // §11.16 (iter-3): on the retrying→failed path the prior
      // retrying-state `toast.loading` set a description; the failure
      // call must pass `description: ""` to override it via Sonner's
      // merge so the diagnostic text doesn't show under the failure
      // message.
      description?: string;
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

/**
 * §12.2 (Decision 13) — active-download Cancel-button bridge. The
 * toaster's `toast.loading(...)` call's Cancel action wires its onClick
 * to `syncApi.cancelJob({ downloadJobId })`. Production resolves
 * `window.api.sync.cancelJob` lazily (mirroring the `filesApi` pattern);
 * tests inject a stub. Fire-and-forget — the toaster does NOT await the
 * Promise; the user-visible signal is the subsequent `download-cancelled`
 * IPC event arriving on the bus, which the toaster's existing
 * `download-cancelled` handler (silent `toast.dismiss`) consumes.
 */
export interface SyncActionsApi {
  cancelJob(req: { downloadJobId: string }): Promise<unknown>;
}

export interface DownloadToasterDeps {
  readonly toast?: ToastApi;
  readonly eventApi?: DownloadEventApi;
  readonly filesApi?: FilesActionsApi;
  readonly syncApi?: SyncActionsApi;
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
    // `loading` and `error` forward `description` verbatim (Sonner's own
    // `loading`/`error` accept it). The `description: ""` clear-pattern
    // used on resume / failure-from-retrying transitions relies on
    // Sonner's `Observer.create()` spread merging the explicit empty
    // string over any prior description — see download-job-toast.ts
    // §11.16 retrying-handler doc-comment for the merge mechanics.
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

function resolveSyncApi(
  injected: SyncActionsApi | undefined,
): SyncActionsApi {
  if (injected) return injected;
  // Production fallback: pull from the preload bridge. Lazy resolution —
  // we look up `window.api.sync.cancelJob` at click time so the toaster
  // can mount safely in test harnesses without the preload (e.g.
  // node-style tests for unrelated code paths). Throwing at the click
  // site keeps the failure mode diagnosable; non-throwing here would
  // silently swallow user clicks.
  type CancelFn = (req: { downloadJobId: string }) => Promise<unknown>;
  return {
    async cancelJob(req) {
      const fn = (
        globalThis as unknown as {
          window?: {
            api?: {
              sync?: { cancelJob?: CancelFn };
            };
          };
        }
      ).window?.api?.sync?.cancelJob;
      if (typeof fn !== "function") {
        throw new Error(
          "createDownloadJobToaster: window.api.sync.cancelJob is unavailable",
        );
      }
      return fn(req);
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

// --- Constants -------------------------------------------------------

/**
 * Auto-dismiss duration for the V2 success toast (Open + Show in folder).
 *
 * Progression:
 *   - Initial: `4000` (mirroring upload's fire-and-forget ack pattern).
 *   - 2026-04-29: bumped to `8000` after user feedback that 4 s was too
 *     short to register the toast and click an action.
 *   - 2026-04-28 (this fix): `Number.POSITIVE_INFINITY` — sticky.
 *
 * Rationale for sticky: download's success toast IS the affordance.
 * The dual-action layout (Show in folder + Open) explicitly invites a
 * user click; auto-dismissing it defeats the point. The user dismisses
 * the toast either by clicking one of the actions (handlers wired to
 * call `toast.dismiss(successId)` after their side-effect) or via
 * Sonner's close-button X (sticky toasts surface it by default).
 *
 * The constant name retains its `_DURATION_MS` suffix so existing test
 * imports (`(c-duration)`) keep working. Upload's success toast still
 * uses 4000 ms — its UX intent is fire-and-forget acknowledgement, not
 * an invitation to act, so the divergence is deliberate.
 *
 * Pinned by test `(c-duration)` in
 * `__tests__/download-job-toast.test.ts`.
 */
export const SUCCESS_TOAST_DURATION_MS = Number.POSITIVE_INFINITY;

// --- Helpers ---------------------------------------------------------

function basenameFromPath(path: string): string {
  // Datasource paths are POSIX — split on `/`. Defensive against a
  // trailing slash (folders never appear in download events; this is
  // belt-and-braces).
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const lastSlash = trimmed.lastIndexOf("/");
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

/**
 * §12.3 (Decision 14) — progress message format with bytes-only fallback.
 *
 * - When `bytesTotal !== null && bytesTotal > 0`: percentage format
 *   `Downloading <basename> — <pct>%`. `pct` is the integer percentage
 *   computed from `bytesLoaded / bytesTotal`; the caller may pass the
 *   pre-computed value via `progressPct` (matching the wire-shape's
 *   `progress` field — the handler already does the floor + clamp).
 * - When `bytesTotal === null` (provider didn't advertise Content-Length
 *   — e.g. Drive `?alt=media` for some media files, chunked transfer
 *   encoding): bytes-only format `Downloading <basename> — <X> MB`
 *   where `X = (bytesLoaded / 1_048_576).toFixed(1)`. When `bytesLoaded
 *   >= 1_073_741_824` (1 GB), scales to `<X> GB` with two decimal places.
 *
 * The bytes-only path preserves user-visible activity signal even when
 * total is unknown — the §11.19 wifi-drop smoke surfaced a 400MB MP4
 * download where Drive returned no Content-Length, leaving the toast
 * stuck at `0%` forever.
 */
function formatProgressMessage(
  basename: string,
  progressPct: number,
  bytesLoaded: number,
  bytesTotal: number | null,
): string {
  if (bytesTotal !== null && bytesTotal > 0) {
    const clamped = Math.max(0, Math.min(100, Math.round(progressPct)));
    return `Downloading ${basename} — ${clamped}%`;
  }
  const ONE_GB = 1_073_741_824;
  const ONE_MB = 1_048_576;
  if (bytesLoaded >= ONE_GB) {
    return `Downloading ${basename} — ${(bytesLoaded / ONE_GB).toFixed(2)} GB`;
  }
  return `Downloading ${basename} — ${(bytesLoaded / ONE_MB).toFixed(1)} MB`;
}

// §11.16 (iter-3): retrying state shares the `toast.loading` render mode
// with the downloading state — only the message + description swap. Same
// id, same chrome (Sonner's loading-template spinner glyph stays
// visible). The earlier `toast.custom` approach (iter-2) was abandoned
// because Sonner's `Observer.create()` carries the prior `type:
// 'loading'` over to the custom render, leaving the spinner-chrome
// overlay on top of the hand-rolled JSX.
function formatRetryingMessage(
  basename: string,
  ctx: { attempt: number; limit: number },
): string {
  return `Downloading ${basename} — Reconnecting (${ctx.attempt}/${ctx.limit})`;
}

function formatRetryingDescription(ctx: {
  engineCause: string;
  waitMs: number;
}): string {
  // §12.4 (Decision 3 rewrite): on the rewrite-from-0 path the handler
  // emits `download-retrying { waitMs: 0, engineCause: "range-not-honored" }`
  // — no sleep precedes the rewrite, so "Waiting 0ms before retry"
  // reads weirdly. Substitute "Restarting download." for the wait
  // phrase when waitMs is zero.
  if (ctx.waitMs === 0) {
    return `Last error: ${ctx.engineCause}. Restarting download.`;
  }
  return `Last error: ${ctx.engineCause}. Waiting ${ctx.waitMs}ms before retry.`;
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
  /**
   * Marker set on terminal events (success / failure). When set, a
   * subsequent duplicate event for the same `downloadJobId` is a no-op
   * — the toast has already had its terminal render and re-spawning
   * would resurrect a dismissed toast (or, worse, race Sonner's
   * dismiss animation; see the post-archive 2026-04-28 fix that moved
   * success to a fresh id). The orchestrator should never emit a
   * duplicate terminal event for the same job, but the bridge / hydrate
   * paths can plausibly race; this flag is the renderer-side guard.
   */
  readonly terminal?: boolean;
  /**
   * Marker set on `download-retrying` events; cleared on the next
   * `downloading` event for the same jobId (per add-download-resilience
   * §7.3). §11.16 (iter-3): the marker no longer signals a render-mode
   * swap — both downloading and retrying use `toast.loading`. It is
   * still useful as state-transition documentation and to support any
   * future logic that needs to know the toast was last in a retry
   * sleep. Production logic does not currently branch on it.
   *
   * The retry context itself is not retained: the renderer SHALL NOT
   * branch on `engineCause` per Decision 9, and the spec only requires
   * the context for the duration of the retrying-state render itself.
   */
  readonly retrying?: boolean;
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
  const syncApi = resolveSyncApi(deps?.syncApi);

  // §12.2 (Decision 13) — Cancel action factory. The toaster injects this
  // into every `toast.loading` call (both the downloading-state and the
  // retrying-state paths, plus the hydration spawn path). The onClick is
  // fire-and-forget — the user-visible signal is the subsequent
  // `download-cancelled` IPC event arriving on the bus, which the
  // toaster's existing `download-cancelled` handler dismisses with
  // `toast.dismiss`. The IPC's response Promise is intentionally
  // discarded (`void`); errors thrown during click (e.g. preload bridge
  // missing in a partial test harness) surface as unhandled rejections
  // in the console — production callers always have the bridge wired,
  // so this only matters for harness misconfigurations.
  function buildCancelAction(downloadJobId: string): {
    label: string;
    onClick: () => void;
  } {
    return {
      label: "Cancel",
      onClick: () => {
        void syncApi.cancelJob({ downloadJobId });
      },
    };
  }

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
        // Update in place. The downloading state and retrying state
        // share the same `toast.loading` render mode (§11.16 iter-3) —
        // they differ only in message + description.
        //
        // Description-merge gotcha: Sonner's `Observer.create()` merges
        // new toast data over the existing toast (`{ ...oldToast,
        // ...newData }`). If the prior call set `description: "Last
        // error: ..."` (the retrying state) and we issue
        // `toast.loading(msg, { id })` without a `description` field,
        // the prior description survives the spread and lingers on
        // screen during the resumed downloading. Pass `description: ""`
        // to override — the view-layer `toast.description ?` truthy
        // check then hides the row. (See node_modules/sonner Observer
        // .create line ~145 and view layer ~797.)
        toast.loading(
          formatProgressMessage(
            existing.basename,
            event.payload.progress,
            event.payload.bytesLoaded,
            event.payload.bytesTotal,
          ),
          {
            id: existing.toastId,
            description: "",
            action: buildCancelAction(downloadJobId),
          },
        );
        if (existing.retrying === true) {
          tracker.set(downloadJobId, {
            toastId: existing.toastId,
            basename: existing.basename,
            retry: existing.retry,
            terminal: existing.terminal,
          });
        }
      } else {
        // Spawn new toast for this jobId. If the orchestrator pre-
        // registered a retry callback for `(datasourceId, sourcePath)`,
        // drain it into the ToastEntry and remove the registry slot
        // (the pairing is one-shot per dispatch).
        const initialId = generateToastId();
        const toastId = toast.loading(
          formatProgressMessage(
            basename,
            event.payload.progress,
            event.payload.bytesLoaded,
            event.payload.bytesTotal,
          ),
          {
            id: initialId,
            action: buildCancelAction(downloadJobId),
          },
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

    if (event.kind === "download-retrying") {
      // §11.16 (iter-3): retrying state uses `toast.loading` — same
      // render mode as the downloading template. Title swaps to
      // `Downloading <basename> — Reconnecting (<attempt>/<limit>)`;
      // diagnostic context (`engineCause`, `waitMs`) renders as Sonner's
      // `description` field (always-visible below the title). Spinner
      // glyph comes from Sonner's loading template natively — same
      // chrome as the downloading state, no transition.
      //
      // Iter-2 used `toast.custom` here. That approach was abandoned
      // because Sonner's `Observer.create()` merges new toast data over
      // the existing toast but preserves the OLD `type` field. A toast
      // that started life as `toast.loading` retained `type: 'loading'`
      // even after `toast.custom`, so the view layer kept rendering the
      // loading-spinner icon overlay on top of our hand-rolled JSX
      // ("corrupted and messy" per §11.10/§11.15 smoke). Decision 5
      // ratified in iter-3: tooltip-on-hover → always-visible
      // description.
      const existing = tracker.get(downloadJobId);
      if (existing?.terminal === true) {
        // Late retry event for an already-terminal job: ignore.
        return;
      }
      const basename = existing?.basename ?? "download";
      const toastId = existing?.toastId ?? generateToastId();
      const { attempt, limit, waitMs, engineCause } = event.payload;
      toast.loading(
        formatRetryingMessage(basename, { attempt, limit }),
        {
          id: toastId,
          description: formatRetryingDescription({ engineCause, waitMs }),
          action: buildCancelAction(downloadJobId),
        },
      );
      // Carry `existing?.retry` forward — for hydrated-from-disk jobs
      // (no orchestrator pre-dispatch through `registerRetry`) this is
      // undefined, so a subsequent failure-toast falls back to dismiss-
      // only on Retry (see ToastEntry.retry docstring).
      tracker.set(downloadJobId, {
        toastId,
        basename,
        retry: existing?.retry,
        retrying: true,
      });
      return;
    }

    if (event.kind === "file-downloaded") {
      const existing = tracker.get(downloadJobId);
      // Duplicate-terminal guard: if this jobId has already received a
      // terminal event, do not re-spawn. (Defensive — see ToastEntry
      // `terminal` docstring.)
      if (existing?.terminal === true) {
        return;
      }
      const basename =
        existing?.basename ?? basenameFromPath(event.payload.savedPath);
      // Post-archive smoke (2026-04-28): the success toast must spawn
      // with a FRESH id, NOT the loading toast's id. Re-using the
      // loading id raced Sonner's dismiss animation — `toast.dismiss(id)`
      // followed immediately by `toast.custom(render, { id })` caused
      // the new toast to inherit the dismiss state and tear down after
      // ~400 ms instead of living for `duration`. The earlier in-place
      // re-render approach (no dismiss, same id) left the loading
      // template's spinner chrome visible. Solution: dismiss the
      // loading id first to clear the spinner chrome, then spawn the
      // success on a deterministic-suffix new id (`<loadingId>-success`)
      // so Sonner treats it as a brand-new toast with no animation
      // state baggage. The deterministic suffix keeps the id
      // predictable for tests and debug logs.
      const loadingId = existing?.toastId;
      const successId =
        loadingId !== undefined
          ? `${String(loadingId)}-success`
          : generateToastId();
      const savedPath = event.payload.savedPath;
      const onOpen = () => {
        void filesApi.openSavedPath(savedPath);
        // Dismiss the success toast itself (not the long-gone loading
        // id) — the user has acted, the affordance is consumed.
        toast.dismiss(successId);
      };
      const onShowInFolder = () => {
        void filesApi.showSavedInFolder(savedPath);
        toast.dismiss(successId);
      };
      // Tear down the loading toast BEFORE spawning the success so the
      // spinner chrome doesn't visually overlap the success render.
      // Skipped when there was no prior loading toast (terminal-as-
      // first-event path).
      if (existing !== undefined) {
        toast.dismiss(loadingId!);
      }
      toast.custom(
        (id) => buildSuccessRender(id, basename, onOpen, onShowInFolder),
        {
          id: successId,
          // Sticky — `Number.POSITIVE_INFINITY`. Sonner respects this
          // sentinel (same pattern used by the failure toast above) and
          // surfaces its default close-button X on sticky toasts. Per
          // SUCCESS_TOAST_DURATION_MS docstring: the success toast IS
          // the affordance, so auto-dismiss would defeat the dual-
          // action layout. The toast clears when the user clicks Open /
          // Show in folder (handlers above call `toast.dismiss`) or via
          // the close-button X. Pinned by test (c-duration).
          duration: SUCCESS_TOAST_DURATION_MS,
          actions: { onOpen, onShowInFolder },
        },
      );
      // Mark terminal in the tracker so a duplicate `file-downloaded`
      // (or a late `download-failed`) for the same jobId becomes a
      // no-op. The entry now references the success id rather than the
      // dismissed loading id.
      tracker.set(downloadJobId, {
        toastId: successId,
        basename,
        terminal: true,
      });
      return;
    }

    if (event.kind === "download-failed") {
      // §11.16 (iter-3): unified failure path uses `toast.error` for
      // every prior render state (loading or retrying). Sonner's
      // built-in type swaps (loading→error, loading→loading) are
      // reliable on the same id (`toast.error()` explicitly sets
      // `type: 'error'` in the merge — see node_modules/sonner
      // index.mjs ~line 209). `toast.custom` was abandoned in iter-3
      // because mixing it with built-in types triggered the
      // type-merge-leak bug (the prior `type: 'loading'` carried
      // over to the custom render, leaving the spinner-chrome
      // overlay on top of our red card).
      //
      // Description-merge gotcha: when the prior render was the
      // retrying state, it set a description ("Last error: ..."). The
      // failure call MUST pass `description: ""` to clear it via
      // Sonner's `Observer.create()` spread merge — otherwise the
      // diagnostic text lingers under the failure message. The clear
      // is unconditional (no-op when no prior description was set).
      const existing = tracker.get(downloadJobId);
      // Duplicate-terminal guard (see file-downloaded handler).
      if (existing?.terminal === true) {
        return;
      }
      // basename is preserved in the tracker for diagnostic continuity
      // (a duplicate-terminal short-circuit can read it later); the
      // failure-message copy itself doesn't surface basename because
      // `event.payload.message` already names the failure mode.
      const basename = existing?.basename ?? "download";
      // Retry callback was correlated on the FIRST `downloading` event
      // for this jobId (drained from `pendingRetries` into the
      // ToastEntry). If failure preceded any `downloading` event (rare
      // — instant auth-revoked / immediate validation reject), no
      // correlation happened and Retry falls back to dismiss-only.
      const retry = existing?.retry;
      const toastId = existing?.toastId ?? generateToastId();
      tracker.set(downloadJobId, {
        toastId,
        basename,
        retry,
        terminal: true,
      });
      toast.error(`Download failed: ${event.payload.message}`, {
        id: toastId,
        duration: Number.POSITIVE_INFINITY,
        richColors: true,
        description: "",
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
        formatProgressMessage(
          basename,
          initialPct,
          job.bytesDownloaded,
          job.contentLength,
        ),
        {
          id: initialId,
          action: buildCancelAction(job.downloadJobId),
        },
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

// --- Failure / retrying-state renders ---------------------------------
//
// §11.16 (iter-3): the dedicated `buildFailureRender` and
// `buildRetryingRender` helpers were removed — both states now use
// Sonner's built-in templates (`toast.error` for failure, `toast.loading`
// with a Reconnecting message + diagnostic description for retrying).
// See the `download-failed` and `download-retrying` handlers above for
// the rationale (`Observer.create()` type-merge leak when mixing
// `toast.custom` with built-in types).
