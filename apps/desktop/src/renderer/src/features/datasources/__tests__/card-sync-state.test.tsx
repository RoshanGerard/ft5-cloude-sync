/** @vitest-environment jsdom */
//
// Phase 10 task 10.1 (RED) — DatasourceCard sync-state derivation.
//
// Per design.md Decision 13, the renderer must compose the engine-bus
// summary state with the sync-event stream from `window.api.sync.onEvent`,
// with the precedence rule:
//
//   if jobs.some(j => j.kind === 'sync' && j.status === 'running')
//     → "syncing" (sync-event state wins)
//   else if jobs.some(j => j.kind === 'sync' && j.status === 'waiting-network')
//     → "waiting-network"
//   else if jobs.some(j => j.kind === 'sync' && j.status === 'queued')
//     → "syncing"
//   else summary.status   // engine-bus fallback
//
// The new slice on `DatasourcesProvider`'s reducer (`jobsByDatasource`) is
// fed by `window.api.sync.onEvent` and seeded by `sync-state-seed`. None of
// that infrastructure exists yet — this file is the RED failing test that
// drives task 10.2's GREEN implementation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DatasourceSummary } from "@ft5/ipc-contracts";
import type {
  JobCompletedPayload,
  SyncEvent,
  SyncStateSeedPayload,
} from "@ft5/ipc-contracts/sync-service-desktop";
import type { JobSummary } from "@ft5/ipc-contracts/sync-service-desktop";

// next/navigation mock — DatasourceCard consumes `useRouter()` even though
// none of the tests below activate Explore. Same hoisted-mock pattern as
// card.test.tsx.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

import { DatasourceCard } from "../card";
import { DatasourcesProvider } from "../store";

// ---------- harness for window.api.sync.onEvent ---------------------------

type SyncListener = (event: SyncEvent) => void;

interface SyncHarness {
  onEvent: ReturnType<typeof vi.fn>;
  listeners: SyncListener[];
  /** Synthesise an event delivery to every registered listener. */
  emit: (event: SyncEvent) => void;
}

let syncHarness: SyncHarness;

function installApiMock(): SyncHarness {
  const listeners: SyncListener[] = [];
  const onEvent = vi.fn((cb: SyncListener) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  });
  // Cast through `unknown` because the renderer's `window-api.d.ts` does not
  // (yet) declare `window.api.sync` — see surprise note in the task report.
  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockReturnValue(new Promise<never>(() => {})),
      add: vi.fn(),
      remove: vi.fn().mockResolvedValue({ ok: true }),
      action: vi.fn(),
      upload: vi.fn().mockResolvedValue({ transactionId: "tx-test" }),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    sync: {
      // The store under test is expected to call `window.api.sync.onEvent`
      // exactly once on mount. Other sync.* members are present as no-op
      // stubs so an inadvertent call surfaces as a clear test failure rather
      // than a TypeError.
      onEvent,
      listJobs: vi.fn(),
      getJob: vi.fn(),
      enqueueUpload: vi.fn(),
      enqueueMirror: vi.fn(),
      cancelJob: vi.fn(),
      authenticateStart: vi.fn(),
      authenticateComplete: vi.fn(),
      getStatus: vi.fn(),
      getRetryPolicy: vi.fn(),
      setRetryPolicy: vi.fn(),
    },
  };
  return {
    onEvent,
    listeners,
    emit: (event) => {
      // Wrap delivery in `act` so React state updates triggered by the
      // store's reducer dispatch are flushed before the test assertion runs.
      act(() => {
        // Snapshot to allow listener-triggered unsubscribes during emit.
        for (const l of [...listeners]) {
          l(event);
        }
      });
    },
  };
}

function renderWithProvider(ui: ReactNode) {
  return render(<DatasourcesProvider>{ui}</DatasourcesProvider>);
}

function buildSummary(
  overrides: Partial<DatasourceSummary> = {},
): DatasourceSummary {
  return {
    id: "ds-1",
    displayName: "Test Drive",
    providerId: "google-drive",
    status: "connected",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 0,
    usage: undefined,
    ...overrides,
  };
}

function buildJobSummary(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "job-sync-1",
    kind: "sync",
    datasourceId: "ds-1",
    sourcePath: "/remote/root",
    targetPath: null,
    conflictPolicy: "overwrite",
    status: "running",
    attempt: 1,
    lastErrorTag: null,
    lastErrorMessage: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
  syncHarness = installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DatasourceCard — sync-event state derivation (Decision 13)", () => {
  it("sync-state-seed with running sync-kind job overrides summary.status='connected' to render syncing badge", async () => {
    // Pre-seed the engine-state with `connected` to prove the sync-event
    // state wins over the summary state.
    const summary = buildSummary({ id: "ds-1", status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    // The store must have registered exactly one onEvent listener on mount.
    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    // Fire the seed.
    const seedPayload: SyncStateSeedPayload = {
      jobs: [
        buildJobSummary({
          id: "job-sync-ds1",
          kind: "sync",
          datasourceId: "ds-1",
          status: "running",
        }),
      ],
    };
    syncHarness.emit({ kind: "sync-state-seed", payload: seedPayload });

    // The badge accessible name must reflect "syncing", and the syncing dot
    // (a structural cue used by other card tests) must be present.
    await waitFor(() => {
      const badge = screen.getByTestId("datasource-status");
      const label =
        badge.getAttribute("aria-label") ?? badge.textContent ?? "";
      expect(label.toLowerCase()).toMatch(/syncing/);
    });
    expect(screen.getByTestId("datasource-syncing-dot")).toBeInTheDocument();
  });

  it("live job-completed for the seeded jobId flips the card from syncing to connected within one frame", async () => {
    const summary = buildSummary({ id: "ds-1", status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    const jobId = "job-sync-ds1";
    const seedPayload: SyncStateSeedPayload = {
      jobs: [
        buildJobSummary({
          id: jobId,
          kind: "sync",
          datasourceId: "ds-1",
          status: "running",
        }),
      ],
    };
    syncHarness.emit({ kind: "sync-state-seed", payload: seedPayload });

    // Sanity: starts in syncing.
    await waitFor(() => {
      const badge = screen.getByTestId("datasource-status");
      const label =
        badge.getAttribute("aria-label") ?? badge.textContent ?? "";
      expect(label.toLowerCase()).toMatch(/syncing/);
    });

    // Now fire job-completed for the same jobId.
    const completedPayload: JobCompletedPayload = {
      jobId,
      completedAt: 1_700_000_000_500,
    };
    syncHarness.emit({ kind: "job-completed", payload: completedPayload });

    // Card flips to the engine-bus fallback (`connected`) once the sync-kind
    // job is removed from the jobsByDatasource bucket. `waitFor` covers the
    // single-frame gap; React reconciliation runs synchronously inside `act`
    // but the assertion accommodates any RAF the store may use.
    await waitFor(() => {
      const badge = screen.getByTestId("datasource-status");
      const label =
        badge.getAttribute("aria-label") ?? badge.textContent ?? "";
      expect(label.toLowerCase()).toMatch(/connected/);
    });
    expect(screen.queryByTestId("datasource-syncing-dot")).toBeNull();
  });

  it("engine-bus error wins as fallback when no sync-kind in-flight job exists for the datasource", async () => {
    // Summary is `error`; no sync-kind job in flight → fallback rule
    // applies, the error badge wins. Proves precedence is NOT
    // "sync wins always" but "sync wins IF in-flight".
    const summary = buildSummary({
      id: "ds-1",
      status: "error",
      errorReason: "Token expired",
    });
    renderWithProvider(<DatasourceCard summary={summary} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    // Emit a seed with NO sync-kind job for ds-1 (an unrelated upload-kind
    // job for ds-1 must NOT change the badge, per Decision 13).
    const seedPayload: SyncStateSeedPayload = {
      jobs: [
        buildJobSummary({
          id: "job-upload-ds1",
          kind: "upload",
          datasourceId: "ds-1",
          status: "running",
        }),
      ],
    };
    syncHarness.emit({ kind: "sync-state-seed", payload: seedPayload });

    // The badge stays `error`.
    const badge = screen.getByTestId("datasource-status");
    const label =
      badge.getAttribute("aria-label") ?? badge.textContent ?? "";
    expect(label.toLowerCase()).toMatch(/error/);
    expect(label).toMatch(/Token expired/i);
    // And no syncing dot.
    expect(screen.queryByTestId("datasource-syncing-dot")).toBeNull();
  });
});
