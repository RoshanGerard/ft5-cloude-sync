// Sync event bridge — main-process event relay from the fs-sync service to
// all registered BrowserWindows.
//
// Responsibilities (tasks 7.2, 7.4, 7.6, 7.8):
//
//   1. Handshake (task 7.2): on creation (and on each reconnect), issues
//      `sync:subscribe-events` THEN `sync:list-jobs` on the client's
//      connection. The list-jobs response is used to build a
//      `sync-state-seed` event filtered to
//      `status ∈ [running, queued, waiting-network]`.
//
//   2. Seed buffering (F-2): the seed is held in `bufferedSeed` until the
//      first window registers. The first window receives it immediately on
//      registration; subsequent registrations do NOT replay the seed — they
//      start seeing live events from the moment of registration onward.
//      This decouples handshake timing from caller registration timing.
//      On reconnect, `bufferedSeed` is reset so the new seed will be held
//      again until a window registers (or delivered immediately if windows
//      are already registered).
//
//   3. Window fan-out (task 7.4): every incoming service event frame is
//      translated from wire `{ kind:'event', name, payload }` to renderer
//      `{ kind, payload }` and broadcast to all registered windows. Closed
//      windows are lazily dropped on broadcast (same pattern as the
//      datasources event-bridge).
//
//   4. Reconnect (task 7.6): the bridge subscribes to `handle.on("reconnect",
//      ...)` and re-issues the full handshake with the new client. It also
//      sends a `service-disconnected` synthetic event on the `disconnect`
//      hook and a `service-reconnected` event after the new handshake
//      completes.
//
//   5. Upload-progress translation (task 7.8 + Bug 1 fix): `job-progress`
//      events for `kind='upload'` jobs are translated to
//      `DatasourcesUploadProgressEvent` (status `uploading`) and emitted on
//      `DATASOURCES_CHANNELS.uploadProgress`. Terminal engine events for
//      upload jobs are also translated: `job-completed` → `status:'completed'`,
//      `job-failed` and `job-cancelled` → `status:'failed'` (with an `error`
//      string when one is available). Without these terminal translations the
//      renderer toaster (`createUploadJobToaster`) never sees a flip-over
//      event and toasts hang at "Uploading 100%" forever.
//      The bridge tracks `jobId → kind` via `job-enqueued` events and seeds
//      the map from the state-seed jobs. Entries are evicted on terminal
//      events to prevent unbounded growth — the eviction runs AFTER the
//      terminal translation so `jobKinds.get(jobId) === 'upload'` is still
//      valid at translation time. Mirror/sync-job progress and terminal
//      events are NOT emitted on this channel.
//
// Singleton guard: `createSyncEventBridge` registers ONE bridge per supervisor
// lifetime. A second call throws to catch double-init bugs — same pattern as
// `sync-client-holder.ts`. A test-only reset is provided.
//
// Signature: `createSyncEventBridge(handle: SupervisorHandle)` — the bridge
// subscribes to the handle's reconnect/disconnect events. The SupervisorHandle
// is the authoritative source of the current SyncClient. Callers must NOT
// pass a stale SyncClient directly — use `handle.getClient()`.
//
// Refs: design.md Decision 5, Decision 8, Decision 12; tasks.md 7.1–7.9.

import type { BrowserWindow } from "electron";
import { shell } from "electron";

import type { EventFrame } from "@ft5/ipc-contracts/sync-service";
import {
  DATASOURCES_CHANNELS,
  type DatasourceSummary,
  type DatasourcesUploadProgressEvent,
} from "@ft5/ipc-contracts";
import {
  SYNC_CHANNELS,
  type SyncEvent,
  type SyncStateSeedPayload,
} from "@ft5/ipc-contracts/sync-service-desktop";

import { getEngine } from "../datasources/engine.js";

import type { SyncClient } from "./client.js";
import type { SupervisorHandle } from "./supervisor.js";

// Active-status filter for the state-seed query.
const ACTIVE_STATUSES = new Set(["running", "queued", "waiting-network"]);

/**
 * Minimal registry surface used by the bridge. Narrowed to the methods
 * the bridge actually invokes so tests can inject a stub without mocking
 * the whole `DatasourceRegistry` (which pulls in `better-sqlite3`).
 *
 * `add` accepts a full `DatasourceSummary` and is called by the
 * `credential-persisted` subscription introduced in
 * `implement-datasource-onboarding` §16. The registry's `add` is
 * idempotent — see §17 + `DatasourceRegistry.add` doc — so a redelivered
 * `credential-persisted` event for an already-known id is a safe no-op
 * (or update if columns differ).
 */
export interface BridgeRegistry {
  setStatus(
    id: string,
    status: "connected" | "syncing" | "paused" | "error",
    errorReason?: string | null,
    errorKind?: string | null,
  ): void;
  add(summary: DatasourceSummary): DatasourceSummary;
}

export interface SyncEventBridgeDeps {
  /**
   * Registry the bridge mutates on `job-completed` (clear stale error)
   * AND on `credential-persisted` (insert/update the row). Optional for
   * testability — production leaves this unset and the bridge falls back
   * to `getEngine().registry`. See `event-bridge.error-healing.test.ts`
   * and `event-bridge.auth.test.ts`.
   */
  registry?: BridgeRegistry;
  /**
   * Browser-launching seam — used to fulfill the `oauth-open-url`
   * bridge-only event by delegating to Electron's `shell.openExternal`.
   * Optional for testability; production wiring leaves this unset and
   * the bridge falls back to the imported `shell.openExternal`.
   * See design.md Decision 6 (browser-open A1).
   */
  openExternal?: (url: string) => void | Promise<void>;
}

export interface SyncEventBridgeHandle {
  /**
   * Register a BrowserWindow to receive sync events. If the bridge has
   * already produced a state-seed and it has not yet been delivered to any
   * window, the seed is delivered immediately to this window and the buffer
   * is cleared. Subsequent registrations do NOT receive a replayed seed.
   */
  registerWindow(win: BrowserWindow): void;
  /**
   * Detach from the handle's event subscriptions, stop broadcasting, and
   * forget all registered windows. Idempotent: a second call is a no-op.
   */
  dispose(): void;
}

// Module-scoped singleton slot (test-only reset below).
let _singletonCreated = false;

export function createSyncEventBridge(
  handle: SupervisorHandle,
  deps?: SyncEventBridgeDeps,
): SyncEventBridgeHandle {
  if (_singletonCreated) {
    throw new Error(
      "createSyncEventBridge: bridge already created for this supervisor — dispose it before creating a new one",
    );
  }
  _singletonCreated = true;
  return _createBridge(handle, deps);
}

/**
 * Internal factory — separated so the reconnect path can create a fresh
 * bridge instance without touching the singleton guard. Also used directly
 * by tests that pass a SyncClient-shaped object wrapped in a minimal handle.
 *
 * @internal
 */
export function _createBridge(
  handle: SupervisorHandle,
  deps?: SyncEventBridgeDeps,
): SyncEventBridgeHandle {
  const windows = new Set<BrowserWindow>();
  let disposed = false;
  let currentUnsubscribeEvents: (() => void) | null = null;

  // Registry resolver — lazy so test invocations without `initEngine()`
  // still succeed as long as the test never triggers `job-completed` or
  // `credential-persisted`. Production callers leave `deps.registry`
  // unset and hit `getEngine()`.
  function resolveRegistry(): BridgeRegistry {
    return deps?.registry ?? getEngine().registry;
  }

  // Browser-launcher resolver — production hits Electron's `shell.openExternal`;
  // tests inject a stub via `deps.openExternal`.
  const openExternal: (url: string) => void | Promise<void> =
    deps?.openExternal ?? ((url) => shell.openExternal(url));

  // F-2: buffer the first sync-state-seed until a window registers.
  // Once delivered to ≥1 window, this is set to null and never replayed.
  // Comment: we intentionally do NOT replay the seed for every new window
  // because storing + replaying the full job list for each late registration
  // has questionable benefit vs. the added complexity. New windows start
  // seeing live events from their moment of registration onward.
  let bufferedSeed: SyncStateSeedPayload | null = null;

  // Track jobId → kind for upload-progress translation (task 7.8).
  // Seeded from state-seed jobs; updated by job-enqueued; evicted on
  // terminal events to prevent unbounded growth.
  const jobKinds = new Map<string, "upload" | "sync">();

  // Track jobId → datasourceId so `job-completed` (whose payload does NOT
  // carry datasourceId) can heal that row's status back to "connected".
  // Same lifecycle rules as `jobKinds`.
  const jobDatasources = new Map<string, string>();

  // Reconnect attempt counter, used for service-reconnected payload.
  let reconnectAttempts = 0;

  // ---------------------------------------------------------------------------
  // Broadcast helpers
  // ---------------------------------------------------------------------------

  function broadcastSyncEvent(event: SyncEvent): void {
    if (disposed) return;
    for (const win of windows) {
      if (win.isDestroyed()) {
        windows.delete(win);
        continue;
      }
      win.webContents.send(SYNC_CHANNELS.event, event);
    }
  }

  function broadcastUploadProgress(event: DatasourcesUploadProgressEvent): void {
    if (disposed) return;
    for (const win of windows) {
      if (win.isDestroyed()) {
        windows.delete(win);
        continue;
      }
      win.webContents.send(DATASOURCES_CHANNELS.uploadProgress, event);
    }
  }

  function deliverSeedToWindow(win: BrowserWindow, seed: SyncStateSeedPayload): void {
    if (win.isDestroyed()) return;
    win.webContents.send(SYNC_CHANNELS.event, {
      kind: "sync-state-seed",
      payload: seed,
    } satisfies SyncEvent);
  }

  // ---------------------------------------------------------------------------
  // Service event listener — attaches to a specific SyncClient
  // ---------------------------------------------------------------------------

  function attachEventListener(client: SyncClient): () => void {
    return client.onEvent((frame: EventFrame) => {
      if (disposed) return;
      const name = frame.name as string;
      const payload = frame.payload as Record<string, unknown>;

      // Track job kinds + owning datasource on enqueue.
      if (name === "job-enqueued" && payload) {
        const jobId = payload["jobId"] as string | undefined;
        const kind = payload["kind"] as "upload" | "sync" | undefined;
        const datasourceId = payload["datasourceId"] as string | undefined;
        if (jobId && kind) {
          jobKinds.set(jobId, kind);
        }
        if (jobId && datasourceId) {
          jobDatasources.set(jobId, datasourceId);
        }
      }

      // On job-completed: heal any stale error_reason / status='error' row.
      // Only job-completed heals — job-failed and job-cancelled might
      // represent a genuine failure we don't want to mask.
      if (name === "job-completed" && payload) {
        const jobId = payload["jobId"] as string | undefined;
        if (jobId) {
          const datasourceId = jobDatasources.get(jobId);
          if (datasourceId) {
            try {
              resolveRegistry().setStatus(datasourceId, "connected");
            } catch (err) {
              console.warn(
                "[sync-event-bridge] healing datasource status failed:",
                err,
              );
            }
          }
        }
      }

      // Bug 1 fix: terminal-event translation for upload jobs.
      // The renderer toaster (`createUploadJobToaster`) waits on a terminal
      // `DatasourcesUploadProgressEvent` to flip the toast off "Uploading
      // X%". The engine emits `job-completed`/`job-failed`/`job-cancelled`
      // but does NOT emit a final `job-progress` event, so without this
      // translation the toast hangs forever.
      //
      // Byte counts on terminal events: emitted as 0/0. The
      // `JobCompletedPayload` does not carry byte counts, and the toaster
      // only consumes byte counts on the `uploading` branch — terminal
      // branches read `status` and `error`. Reporting 0/0 is honest about
      // "we don't know" rather than smuggling stale per-job state.
      //
      // Cancellation: mapped to `status: 'failed'` with an explicit
      // "upload was cancelled" error message. The contract only allows
      // `uploading | completed | failed`, and surfacing a Retry-able
      // failed toast is preferable to a silently-stuck loading toast.
      //
      // MUST run BEFORE the eviction block below — eviction deletes the
      // jobKinds entry and we need `jobKinds.get(jobId) === 'upload'` to
      // still resolve here.
      if (
        (name === "job-completed" || name === "job-failed" || name === "job-cancelled") &&
        payload
      ) {
        const jobId = payload["jobId"] as string | undefined;
        if (jobId && jobKinds.get(jobId) === "upload") {
          let status: DatasourcesUploadProgressEvent["status"];
          let errorMessage: string | undefined;
          if (name === "job-completed") {
            status = "completed";
          } else if (name === "job-failed") {
            status = "failed";
            errorMessage =
              (payload["errorMessage"] as string | undefined) ??
              (payload["error"] as string | undefined) ??
              (payload["message"] as string | undefined);
          } else {
            // job-cancelled
            status = "failed";
            errorMessage = "upload was cancelled";
          }
          const terminalEvent: DatasourcesUploadProgressEvent = {
            transactionId: jobId,
            bytesUploaded: 0,
            bytesTotal: 0,
            status,
            ...(errorMessage ? { error: errorMessage } : {}),
          };
          broadcastUploadProgress(terminalEvent);
        }
      }

      // Evict terminal events to prevent unbounded growth.
      if (
        (name === "job-completed" || name === "job-failed" || name === "job-cancelled") &&
        payload
      ) {
        const jobId = payload["jobId"] as string | undefined;
        if (jobId) {
          jobKinds.delete(jobId);
          jobDatasources.delete(jobId);
        }
      }

      // Upload-progress translation: job-progress for upload jobs →
      // DatasourcesUploadProgressEvent on the uploadProgress channel.
      // Mirror-job progress is NOT emitted on this channel.
      if (name === "job-progress" && payload) {
        const jobId = payload["jobId"] as string | undefined;
        if (jobId && jobKinds.get(jobId) === "upload") {
          const bytesSent = (payload["bytesSent"] as number | undefined) ?? 0;
          const totalBytes = (payload["totalBytes"] as number | null | undefined) ?? 0;
          const uploadProgress: DatasourcesUploadProgressEvent = {
            transactionId: jobId,
            bytesUploaded: bytesSent,
            bytesTotal: totalBytes ?? 0,
            status: "uploading",
          };
          broadcastUploadProgress(uploadProgress);
        }
      }

      // implement-datasource-onboarding §16 — bridge-only auth events.
      //
      // `oauth-open-url` drives `shell.openExternal(authorizeUrl)` and is
      // NEVER delivered to the renderer. Per design.md Decision 6 (browser-
      // open A1), the renderer is URL-blind; the desktop main is the
      // shell.openExternal trampoline.
      //
      // `credential-persisted` drives `registry.add(summary)` (idempotent —
      // see §17) and is NEVER delivered to the renderer. The paired
      // user-facing event is `auth-completed`, which DOES travel onward to
      // the renderer per the same decision.
      //
      // Both events return AFTER their side effect — the relay below MUST
      // NOT see them. See specs/datasources-ui/spec.md "Desktop main-process
      // bridge translates service authenticate events into local actions".
      if (name === "oauth-open-url" && payload) {
        const authorizeUrl = payload["authorizeUrl"] as string | undefined;
        if (typeof authorizeUrl === "string" && authorizeUrl.length > 0) {
          try {
            void openExternal(authorizeUrl);
          } catch (err) {
            console.warn(
              "[sync-event-bridge] shell.openExternal failed:",
              err,
            );
          }
        }
        return; // do NOT forward to renderer
      }
      if (name === "credential-persisted" && payload) {
        const summary = payload["summary"] as DatasourceSummary | undefined;
        if (summary) {
          try {
            resolveRegistry().add(summary);
          } catch (err) {
            // §16 design — orphan-credentials window. Log a structured
            // warning matching Risks §1's `bridge-registry-add-failed`
            // diagnostic; do NOT throw (the event stream must keep
            // flowing).
            console.warn(
              "[sync-event-bridge] bridge-registry-add-failed:",
              { datasourceId: summary.id, errorMessage: (err as Error).message },
            );
          }
        }
        return; // do NOT forward to renderer
      }

      // Relay every service event to the renderer (name → kind translation).
      // Cast via unknown to satisfy the discriminated union; the wire
      // contract guarantees name is a valid EventName.
      broadcastSyncEvent({ kind: name, payload } as unknown as SyncEvent);
    });
  }

  // ---------------------------------------------------------------------------
  // Handshake: subscribe-events first (to avoid gap), then list-jobs.
  // Design ref: design.md Decision 5.
  // Called at initial connect AND on every reconnect.
  // ---------------------------------------------------------------------------

  async function doHandshake(
    client: SyncClient,
    opts: { isReconnect: boolean } = { isReconnect: false },
  ): Promise<void> {
    if (disposed) return;

    try {
      // Subscribe first to arm the event stream before we snapshot state.
      await client.request("sync:subscribe-events", {});

      // Then list active jobs for the seed.
      const result = await client.request("sync:list-jobs", {
        filter: { status: ["running", "queued", "waiting-network"] },
      });

      if (disposed) return;

      // wire result is `{ jobs: readonly JobSummary[] }` — use type narrowing
      // via `unknown` to avoid direct readonly→mutable cast conflicts.
      const wireResult = result as unknown as { jobs: Array<{ id: string; kind: string; status: string; datasourceId: string; sourcePath: string; targetPath: string | null; conflictPolicy: string; attempt: number; lastErrorTag: string | null; lastErrorMessage: string | null; createdAt: number; updatedAt: number }> };
      const jobs = wireResult.jobs.filter(
        (j) => ACTIVE_STATUSES.has(j.status),
      );

      // Seed the job-kind + owning-datasource maps from the state snapshot.
      for (const j of jobs) {
        if (j.kind === "upload" || j.kind === "sync") {
          jobKinds.set(j.id, j.kind as "upload" | "sync");
        }
        if (j.datasourceId) {
          jobDatasources.set(j.id, j.datasourceId);
        }
      }

      const seed: SyncStateSeedPayload = { jobs: jobs as unknown as SyncStateSeedPayload["jobs"] };

      // F-2: if windows are already registered, broadcast immediately and
      // skip buffering. Otherwise buffer until registerWindow is called.
      if (windows.size > 0) {
        broadcastSyncEvent({ kind: "sync-state-seed", payload: seed });
        // bufferedSeed stays null — already delivered.
      } else {
        bufferedSeed = seed;
      }

      // Emit service-reconnected only AFTER a successful handshake — the
      // renderer's "service is back, state is fresh" signal must follow the
      // seed that makes the state fresh. On initial connect, isReconnect is
      // false and this branch is skipped.
      // Addresses code-review I-A; preserves Decision 5's zero-gap-seed
      // invariant when the service returns a soft error to sync:list-jobs.
      if (opts.isReconnect) {
        broadcastSyncEvent({
          kind: "service-reconnected",
          payload: {
            observedAt: Date.now(),
            reconnectAttempts,
          },
        });
      }
    } catch (err) {
      // Handshake failures (client disconnected, service error). A transport
      // disconnect will re-trigger the reconnect loop and retry the handshake;
      // a soft command error leaves the renderer without a service-reconnected
      // (the old state-unreliable signal stays in force). Log so operators can
      // see repeated handshake failures.
      console.warn("[sync-event-bridge] handshake failed:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Supervisor disconnect/reconnect subscriptions
  // ---------------------------------------------------------------------------

  const unsubscribeDisconnect = handle.on("disconnect", () => {
    if (disposed) return;
    // Emit service-disconnected to all registered windows
    broadcastSyncEvent({
      kind: "service-disconnected",
      payload: {
        reason: "socket-closed",
        observedAt: Date.now(),
      },
    });
  });

  const unsubscribeReconnect = handle.on("reconnect", (newClient) => {
    if (disposed) return;
    reconnectAttempts++;

    // Detach from old client's event stream and attach to new client
    if (currentUnsubscribeEvents) {
      currentUnsubscribeEvents();
    }
    currentUnsubscribeEvents = attachEventListener(newClient);

    // Reset buffered seed so the reconnect handshake can buffer if needed
    bufferedSeed = null;

    // Re-issue the handshake on the new connection; service-reconnected is
    // emitted from inside doHandshake AFTER a successful seed broadcast/buffer
    // (see doHandshake for rationale).
    void doHandshake(newClient, { isReconnect: true });
  });

  // Attach to the initial client's event stream
  currentUnsubscribeEvents = attachEventListener(handle.getClient());

  // Run the initial handshake
  void doHandshake(handle.getClient());

  // ---------------------------------------------------------------------------
  // Public handle
  // ---------------------------------------------------------------------------

  return {
    registerWindow(win: BrowserWindow): void {
      if (disposed) return;
      windows.add(win);
      // F-2: deliver the buffered seed to the first registrant, then clear.
      if (bufferedSeed !== null) {
        deliverSeedToWindow(win, bufferedSeed);
        bufferedSeed = null;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeDisconnect();
      unsubscribeReconnect();
      if (currentUnsubscribeEvents) {
        currentUnsubscribeEvents();
        currentUnsubscribeEvents = null;
      }
      windows.clear();
      bufferedSeed = null;
      _singletonCreated = false;
    },
  };
}

/** Test-only reset of the singleton guard. Do not call from production code. */
export function __resetSyncEventBridgeForTesting(): void {
  _singletonCreated = false;
}
