"use client";

//
// DatasourcesProvider + hooks (task 5.2).
//
// A React Context + `useReducer` state machine for the datasources dashboard.
// Decision 5 of design.md rejects state libraries (Zustand/Jotai/Redux) — we
// stick with plain React primitives so the dependency graph stays small and
// typed end-to-end.
//
// State machine shapes:
//   - `loading`   — initial fetch in flight, no data yet
//   - `empty`     — fetch resolved with `datasources: []`
//   - `populated` — fetch resolved with at least one summary
//   - `error`     — fetch rejected; we surface the error message
//
// Mutation hooks (`add`, `remove`, `action`, `upload`) are thin passthroughs
// to `window.api.datasources.*` with optimistic local reconciliation on
// success. Errors bubble through the returned promise so callers can toast /
// surface them; the store only updates on successful responses.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type {
  DatasourcesActionRequest,
  DatasourcesActionResponse,
  DatasourcesAddRequest,
  DatasourcesAddResponse,
  DatasourcesRemoveRequest,
  DatasourcesRemoveResponse,
  DatasourceSummary,
} from "@ft5/ipc-contracts";
import type {
  JobCancelledPayload,
  JobCompletedPayload,
  JobEnqueuedPayload,
  JobFailedPayload,
  JobProgressPayload,
  JobRecoveredPayload,
  JobStartedPayload,
  JobSummary,
  SyncEvent,
  SyncStateSeedPayload,
} from "@ft5/ipc-contracts/sync-service-desktop";

export type DatasourcesState =
  | { phase: "loading" }
  | { phase: "empty" }
  | { phase: "populated"; datasources: DatasourceSummary[] }
  | { phase: "error"; error: string };

type Action =
  | { type: "load/start" }
  | { type: "load/success"; datasources: DatasourceSummary[] }
  | { type: "load/failure"; error: string }
  | { type: "datasource/added"; datasource: DatasourceSummary }
  | { type: "datasource/removed"; datasourceId: string }
  | { type: "datasource/updated"; datasource: DatasourceSummary };

function reducer(state: DatasourcesState, action: Action): DatasourcesState {
  switch (action.type) {
    case "load/start":
      return { phase: "loading" };
    case "load/success":
      return action.datasources.length === 0
        ? { phase: "empty" }
        : { phase: "populated", datasources: action.datasources };
    case "load/failure":
      return { phase: "error", error: action.error };
    case "datasource/added": {
      if (state.phase === "populated") {
        return {
          phase: "populated",
          datasources: [...state.datasources, action.datasource],
        };
      }
      // From empty/loading/error, adding one summary makes us populated.
      return { phase: "populated", datasources: [action.datasource] };
    }
    case "datasource/removed": {
      if (state.phase !== "populated") return state;
      const next = state.datasources.filter(
        (d) => d.id !== action.datasourceId,
      );
      return next.length === 0
        ? { phase: "empty" }
        : { phase: "populated", datasources: next };
    }
    case "datasource/updated": {
      if (state.phase !== "populated") return state;
      return {
        phase: "populated",
        datasources: state.datasources.map((d) =>
          d.id === action.datasource.id ? action.datasource : d,
        ),
      };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Jobs slice (Decision 13 — Renderer card sync-state derivation).
//
// Fed by `window.api.sync.onEvent`. Seeded on mount by the `sync-state-seed`
// event (snapshot of in-progress jobs from the supervisor handshake) and
// maintained by per-job lifecycle events. The card's display state is
// derived from the union of this slice and the engine-bus `summary.status`
// with the precedence rule spelled out in design.md Decision 13.
//
// Shape mirrors Decision 13 (amended in 45902d6). Both slices are fed by
// the SAME `window.api.sync.onEvent` subscription: `jobsByDatasource` from
// the seed + lifecycle events, `uploadProgressByJob` from `job-progress`
// events whose jobId belongs to a kind=upload row in `jobsByDatasource`.
// There is NO second `DATASOURCES_CHANNELS.uploadProgress` consumer —
// the legacy channel still exists for `window.api.datasources.onUploadProgress`
// callers, but section 10's bar consumes the upstream SyncEvent directly so
// store-membership and per-job byte ticks share a single ordered stream.
// ---------------------------------------------------------------------------

export interface JobsState {
  readonly jobsByDatasource: Map<string, JobSummary[]>;
  readonly uploadProgressByJob: Map<
    string,
    { readonly bytesUploaded: number; readonly bytesTotal: number }
  >;
}

type JobsAction =
  | { type: "sync/state-seed"; payload: SyncStateSeedPayload }
  | { type: "sync/job-enqueued"; payload: JobEnqueuedPayload }
  | { type: "sync/job-started"; payload: JobStartedPayload }
  | { type: "sync/job-progress"; payload: JobProgressPayload }
  | { type: "sync/job-completed"; payload: JobCompletedPayload }
  | { type: "sync/job-failed"; payload: JobFailedPayload }
  | { type: "sync/job-cancelled"; payload: JobCancelledPayload }
  | { type: "sync/job-recovered"; payload: JobRecoveredPayload };

const EMPTY_JOBS_STATE: JobsState = {
  jobsByDatasource: new Map(),
  uploadProgressByJob: new Map(),
};

// Helper: find the bucket + index for a jobId. O(buckets * jobs_per_bucket)
// which, in practice, is at most a handful per datasource.
function findJobLocation(
  byDs: Map<string, JobSummary[]>,
  jobId: string,
): { datasourceId: string; index: number } | null {
  for (const [datasourceId, jobs] of byDs) {
    const index = jobs.findIndex((j) => j.id === jobId);
    if (index >= 0) return { datasourceId, index };
  }
  return null;
}

// Upsert a job into the datasource's bucket. Returns a NEW Map (reducer
// immutability). `getUpdated` is called with the current row if one exists
// so callers can produce a merged JobSummary from a partial event payload;
// otherwise it's called with `null` and must construct the full row.
function upsertJob(
  byDs: Map<string, JobSummary[]>,
  datasourceId: string,
  jobId: string,
  getUpdated: (existing: JobSummary | null) => JobSummary | null,
): Map<string, JobSummary[]> {
  const loc = findJobLocation(byDs, jobId);
  // If the job lives in a different bucket, we treat it as a move by
  // evicting from the old bucket first. In practice the datasourceId doesn't
  // change mid-lifecycle — this is defensive.
  const working = new Map(byDs);
  if (loc && loc.datasourceId !== datasourceId) {
    const oldBucket = working.get(loc.datasourceId)!;
    const next = oldBucket.filter((_, i) => i !== loc.index);
    if (next.length === 0) working.delete(loc.datasourceId);
    else working.set(loc.datasourceId, next);
  }
  const existing =
    loc && loc.datasourceId === datasourceId
      ? working.get(datasourceId)![loc.index] ?? null
      : null;
  const updated = getUpdated(existing);
  if (updated === null) return working;
  const bucket = working.get(datasourceId) ?? [];
  if (existing) {
    const next = bucket.slice();
    const idx = next.findIndex((j) => j.id === jobId);
    next[idx] = updated;
    working.set(datasourceId, next);
  } else {
    working.set(datasourceId, [...bucket, updated]);
  }
  return working;
}

// Remove a job by jobId across all buckets. Returns a new Map. If the bucket
// goes empty, the datasourceId key is deleted to bound memory.
function removeJob(
  byDs: Map<string, JobSummary[]>,
  jobId: string,
): Map<string, JobSummary[]> {
  const loc = findJobLocation(byDs, jobId);
  if (!loc) return byDs;
  const working = new Map(byDs);
  const bucket = working.get(loc.datasourceId)!;
  const next = bucket.filter((j) => j.id !== jobId);
  if (next.length === 0) working.delete(loc.datasourceId);
  else working.set(loc.datasourceId, next);
  return working;
}

function jobsReducer(state: JobsState, action: JobsAction): JobsState {
  switch (action.type) {
    case "sync/state-seed": {
      // Replace the whole map. Jobs may be empty — seed still wins.
      const next = new Map<string, JobSummary[]>();
      for (const job of action.payload.jobs) {
        const bucket = next.get(job.datasourceId);
        if (bucket) bucket.push(job);
        else next.set(job.datasourceId, [job]);
      }
      // Evict `uploadProgressByJob` entries that reference jobs not in the
      // seed — the authoritative cross-process truth just overwrote ours.
      const liveJobIds = new Set(action.payload.jobs.map((j) => j.id));
      const nextProgress = new Map<
        string,
        { bytesUploaded: number; bytesTotal: number }
      >();
      for (const [jobId, progress] of state.uploadProgressByJob) {
        if (liveJobIds.has(jobId)) nextProgress.set(jobId, progress);
      }
      return {
        jobsByDatasource: next,
        uploadProgressByJob: nextProgress,
      };
    }
    case "sync/job-enqueued": {
      const p = action.payload;
      return {
        ...state,
        jobsByDatasource: upsertJob(
          state.jobsByDatasource,
          p.datasourceId,
          p.jobId,
          (existing) => {
            if (existing) return { ...existing, status: "queued" };
            return {
              id: p.jobId,
              kind: p.kind,
              datasourceId: p.datasourceId,
              sourcePath: p.sourcePath,
              targetPath: p.targetPath,
              conflictPolicy: p.conflictPolicy,
              status: "queued",
              attempt: 0,
              lastErrorTag: null,
              lastErrorMessage: null,
              createdAt: p.enqueuedAt,
              updatedAt: p.enqueuedAt,
            };
          },
        ),
      };
    }
    case "sync/job-started": {
      const p = action.payload;
      // We don't know the datasourceId from the payload, so only update if
      // the job already exists in some bucket. If it doesn't, the seed or an
      // earlier `job-enqueued` will have placed it — dropping an orphaned
      // `job-started` is correct.
      const loc = findJobLocation(state.jobsByDatasource, p.jobId);
      if (!loc) return state;
      return {
        ...state,
        jobsByDatasource: upsertJob(
          state.jobsByDatasource,
          loc.datasourceId,
          p.jobId,
          (existing) =>
            existing
              ? {
                  ...existing,
                  status: "running",
                  attempt: p.attempt,
                  updatedAt: p.startedAt,
                }
              : null,
        ),
      };
    }
    case "sync/job-progress": {
      // `job-progress` does not carry status; it's a running-state tick. We
      // refresh `updatedAt` so sort/tiebreak consumers can see freshness,
      // but leave status alone. Only touch the entry if it exists.
      //
      // Decision 13 amended (commit 45902d6): for `kind === "upload"` jobs,
      // this same dispatch also populates `uploadProgressByJob` so the card
      // progress bar reads from a single SyncEvent stream. Wire payload
      // mapping per Decision 13: `bytesSent` → `bytesUploaded`,
      // `totalBytes` → `bytesTotal` (defaulting to 0 when the wire payload
      // says null — this is the "indeterminate" state that renders the bar
      // at value 0 until the first sized tick arrives).
      const p = action.payload;
      const loc = findJobLocation(state.jobsByDatasource, p.jobId);
      if (!loc) return state;
      const job = state.jobsByDatasource.get(loc.datasourceId)?.[loc.index];
      const nextByDs = upsertJob(
        state.jobsByDatasource,
        loc.datasourceId,
        p.jobId,
        (existing) =>
          existing ? { ...existing, updatedAt: Date.now() } : null,
      );
      // Defensive: if findJobLocation returned a stale loc the lookup above
      // could yield undefined — fall back to the jobsByDatasource refresh
      // only and skip the upload-progress branch.
      if (!job || job.kind !== "upload") {
        return { ...state, jobsByDatasource: nextByDs };
      }
      const nextProgress = new Map(state.uploadProgressByJob);
      nextProgress.set(p.jobId, {
        bytesUploaded: p.bytesSent,
        bytesTotal: p.totalBytes ?? 0,
      });
      return {
        jobsByDatasource: nextByDs,
        uploadProgressByJob: nextProgress,
      };
    }
    case "sync/job-completed":
    case "sync/job-failed":
    case "sync/job-cancelled": {
      const jobId = action.payload.jobId;
      const nextByDs = removeJob(state.jobsByDatasource, jobId);
      if (nextByDs === state.jobsByDatasource) return state;
      // Also evict upload-progress entry so long-running renderers don't
      // accumulate completed upload metadata.
      const nextProgress = state.uploadProgressByJob.has(jobId)
        ? (() => {
            const m = new Map(state.uploadProgressByJob);
            m.delete(jobId);
            return m;
          })()
        : state.uploadProgressByJob;
      return {
        jobsByDatasource: nextByDs,
        uploadProgressByJob: nextProgress,
      };
    }
    case "sync/job-recovered": {
      const p = action.payload;
      const loc = findJobLocation(state.jobsByDatasource, p.jobId);
      if (!loc) return state;
      return {
        ...state,
        jobsByDatasource: upsertJob(
          state.jobsByDatasource,
          loc.datasourceId,
          p.jobId,
          (existing) =>
            existing
              ? {
                  ...existing,
                  status: p.priorStatus, // "running"
                  attempt: p.attempt,
                  lastErrorTag: p.lastErrorTag,
                  updatedAt: Date.now(),
                }
              : null,
        ),
      };
    }
    default:
      return state;
  }
}

// `sync-completed` / `source-unavailable` / `network-available` /
// `service-disconnected` / `service-reconnected` are intentionally NOT
// wired into the reducer above. Per Decision 13, the card's display-state
// derivation does not depend on them; they are observed only by ancillary
// surfaces (network banner, toasts) that can subscribe to
// `window.api.sync.onEvent` independently when they ship.

export interface DatasourceActions {
  refresh: () => Promise<void>;
  add: (req: DatasourcesAddRequest) => Promise<DatasourcesAddResponse>;
  remove: (
    req: DatasourcesRemoveRequest,
  ) => Promise<DatasourcesRemoveResponse>;
  action: (
    req: DatasourcesActionRequest,
  ) => Promise<DatasourcesActionResponse>;
}

interface DatasourcesContextValue {
  state: DatasourcesState;
  jobs: JobsState;
  actions: DatasourceActions;
}

const DatasourcesContext = createContext<DatasourcesContextValue | null>(null);

export interface DatasourcesProviderProps {
  children: ReactNode;
}

export function DatasourcesProvider({ children }: DatasourcesProviderProps) {
  const [state, dispatch] = useReducer(reducer, {
    phase: "loading",
  } as DatasourcesState);

  // Decision-13 jobs slice. Driven exclusively by `window.api.sync.onEvent`.
  const [jobs, dispatchJobs] = useReducer(jobsReducer, EMPTY_JOBS_STATE);

  // Mount sentinel: gates every post-await dispatch so we do not call
  // `setState` on an unmounted provider (React 19 strict-mode double-mount
  // can otherwise race two in-flight `list()` calls). Mutation callers still
  // receive the resolved response — only local reconciliation is skipped.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    dispatch({ type: "load/start" });
    try {
      const response = await window.api.datasources.list();
      if (!mountedRef.current) return;
      dispatch({
        type: "load/success",
        datasources: response.datasources,
      });
    } catch (err) {
      if (!mountedRef.current) return;
      const message =
        err instanceof Error ? err.message : "Failed to load datasources.";
      dispatch({ type: "load/failure", error: message });
    }
  }, []);

  const add = useCallback(
    async (req: DatasourcesAddRequest): Promise<DatasourcesAddResponse> => {
      const response = await window.api.datasources.add(req);
      if (mountedRef.current) {
        dispatch({
          type: "datasource/added",
          datasource: response.datasource,
        });
      }
      return response;
    },
    [],
  );

  const remove = useCallback(
    async (
      req: DatasourcesRemoveRequest,
    ): Promise<DatasourcesRemoveResponse> => {
      const response = await window.api.datasources.remove(req);
      if (mountedRef.current) {
        dispatch({
          type: "datasource/removed",
          datasourceId: req.datasourceId,
        });
      }
      return response;
    },
    [],
  );

  const action = useCallback(
    async (
      req: DatasourcesActionRequest,
    ): Promise<DatasourcesActionResponse> => {
      const response = await window.api.datasources.action(req);
      if (mountedRef.current) {
        dispatch({
          type: "datasource/updated",
          datasource: response.datasource,
        });
      }
      return response;
    },
    [],
  );

  // Note: the legacy `upload` mutation was retired in
  // `add-file-explorer-drag-drop-upload` (Task 6.3). The datasource card's
  // "Upload from local…" quick-action now opens the in-app Upload dialog
  // directly; `window.api.datasources.upload` is no longer in the preload
  // bridge. Progress events still flow through
  // `window.api.datasources.onUploadProgress` for `jobId`-keyed toasts.

  // Initial load on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sync-event subscription (Decision 13). Subscribes EXACTLY ONCE per
  // provider instance via `useEffect` with empty deps; the cleanup detaches
  // the listener so React 19 strict-mode double-mount stays safe (the
  // intervening cleanup runs between mounts).
  //
  // Defensive guard: legacy renderer test harnesses install only the
  // `datasources` corner of `window.api`. If `sync` is absent we silently
  // skip the subscription so those tests stay green; production preload
  // (apps/desktop/src/preload/index.ts task 6.2) always exposes `sync`.
  useEffect(() => {
    const syncApi = window.api?.sync;
    if (!syncApi) return;

    // Pull the initial state via request-response in addition to
    // subscribing to the pushed sync-state-seed event. The pushed event
    // races the renderer's ipcRenderer.on() subscription — on a fresh
    // desktop relaunch with an already-warm service, the main-process
    // handshake can complete and broadcast the seed BEFORE React has
    // mounted this effect, so the seed is silently dropped. The pull
    // path below has guaranteed delivery (IPC request-response waits on
    // the sender side) and lets the renderer recover on its own clock.
    void (async () => {
      try {
        const res = await syncApi.listJobs({
          filter: {
            statuses: ["running", "queued", "waiting-network"],
          },
        });
        if (!mountedRef.current) return;
        dispatchJobs({
          type: "sync/state-seed",
          payload: { jobs: res.jobs },
        });
      } catch (err) {
        console.warn("[sync] initial listJobs failed:", err);
      }
    })();

    const unsubscribe = syncApi.onEvent((event: SyncEvent) => {
      if (!mountedRef.current) return;
      switch (event.kind) {
        case "sync-state-seed":
          dispatchJobs({ type: "sync/state-seed", payload: event.payload });
          return;
        case "job-enqueued":
          dispatchJobs({ type: "sync/job-enqueued", payload: event.payload });
          return;
        case "job-started":
          dispatchJobs({ type: "sync/job-started", payload: event.payload });
          return;
        case "job-progress":
          dispatchJobs({ type: "sync/job-progress", payload: event.payload });
          return;
        case "job-completed":
          dispatchJobs({ type: "sync/job-completed", payload: event.payload });
          // Re-fetch datasource summaries so status/errorReason healed by
          // the main-process event-bridge (setStatus(id, "connected") on
          // job-completed) appears on the card. Without this the card
          // keeps showing stale `error_reason` from before the healing
          // write landed.
          void refresh();
          return;
        case "job-failed":
          dispatchJobs({ type: "sync/job-failed", payload: event.payload });
          return;
        case "job-cancelled":
          dispatchJobs({ type: "sync/job-cancelled", payload: event.payload });
          return;
        case "job-recovered":
          dispatchJobs({ type: "sync/job-recovered", payload: event.payload });
          return;
        // Per Decision 13, the card derivation does NOT depend on these.
        // Ancillary surfaces (toasts, banners) can subscribe independently.
        case "sync-completed":
        case "source-unavailable":
        case "network-available":
        case "service-disconnected":
        case "service-reconnected":
          return;
        default:
          return;
      }
    });
    return unsubscribe;
    // refresh is reference-stable (useCallback with []), so including it
    // here won't cause re-subscription.
  }, [refresh]);

  const actions = useMemo<DatasourceActions>(
    () => ({ refresh, add, remove, action }),
    [refresh, add, remove, action],
  );

  const value = useMemo<DatasourcesContextValue>(
    () => ({ state, jobs, actions }),
    [state, jobs, actions],
  );

  return (
    <DatasourcesContext.Provider value={value}>
      {children}
    </DatasourcesContext.Provider>
  );
}

export function useDatasources(): DatasourcesState {
  const ctx = useContext(DatasourcesContext);
  if (ctx === null) {
    throw new Error(
      "useDatasources must be used within a <DatasourcesProvider>.",
    );
  }
  return ctx.state;
}

export function useDatasourceActions(): DatasourceActions {
  const ctx = useContext(DatasourcesContext);
  if (ctx === null) {
    throw new Error(
      "useDatasourceActions must be used within a <DatasourcesProvider>.",
    );
  }
  return ctx.actions;
}

const EMPTY_JOBS: ReadonlyArray<JobSummary> = [];

/**
 * Read-only access to the in-flight job list for one datasource. Used by
 * `DatasourceCard` to derive the live display status per Decision 13.
 *
 * Returns a stable empty array reference when no jobs are tracked, so
 * callers can safely use `.length` / `.some(...)` without optional checks.
 */
export function useDatasourceJobs(datasourceId: string): ReadonlyArray<JobSummary> {
  const ctx = useContext(DatasourcesContext);
  if (ctx === null) {
    throw new Error(
      "useDatasourceJobs must be used within a <DatasourcesProvider>.",
    );
  }
  return ctx.jobs.jobsByDatasource.get(datasourceId) ?? EMPTY_JOBS;
}

export interface UploadProgressView {
  readonly jobId: string;
  readonly bytesUploaded: number;
  readonly bytesTotal: number;
  /** Integer percent in [0, 100], rounded. 0 when bytesTotal === 0. */
  readonly percent: number;
}

/**
 * Returns the upload-progress view for the active upload job on this
 * datasource, or null if no upload-kind job is in flight.
 *
 * "Active" tiebreak: `createdAt desc, then jobId lex desc` per Decision 13
 * (amended in commit 2a23c63). The wire `JobSummary`
 * (packages/ipc-contracts/src/sync-service/commands.ts) carries no
 * `startedAt` field, and `updatedAt` is overwritten on every `job-progress`
 * tick for freshness, so `createdAt` is the only stable per-job ordinal.
 */
export function useDatasourceUploadProgress(
  datasourceId: string,
): UploadProgressView | null {
  const ctx = useContext(DatasourcesContext);
  if (ctx === null) {
    throw new Error(
      "useDatasourceUploadProgress must be used within a <DatasourcesProvider>.",
    );
  }
  const bucket = ctx.jobs.jobsByDatasource.get(datasourceId);
  if (!bucket) return null;
  const candidates = bucket.filter(
    (j) =>
      j.kind === "upload" &&
      (j.status === "running" ||
        j.status === "queued" ||
        j.status === "waiting-network"),
  );
  if (candidates.length === 0) return null;
  // Stable sort: createdAt desc (newest enqueued wins), then id lex desc.
  // Linear scan over a small bucket — no need for a memoised selector.
  const sorted = [...candidates].sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    if (b.id < a.id) return -1;
    if (b.id > a.id) return 1;
    return 0;
  });
  const picked = sorted[0];
  // `candidates.length === 0` was checked above, so `picked` is defined.
  // The non-null assertion satisfies noUncheckedIndexedAccess without
  // forcing a runtime branch consumers don't need.
  if (!picked) return null;
  const progress = ctx.jobs.uploadProgressByJob.get(picked.id);
  if (!progress) {
    // No tick has arrived yet — render the indeterminate state at value 0.
    return {
      jobId: picked.id,
      bytesUploaded: 0,
      bytesTotal: 0,
      percent: 0,
    };
  }
  const percent =
    progress.bytesTotal > 0
      ? Math.round((progress.bytesUploaded / progress.bytesTotal) * 100)
      : 0;
  return {
    jobId: picked.id,
    bytesUploaded: progress.bytesUploaded,
    bytesTotal: progress.bytesTotal,
    percent,
  };
}
