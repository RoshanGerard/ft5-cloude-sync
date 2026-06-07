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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DatasourceSummary } from "@ft5/ipc-contracts";
import type {
  JobCompletedPayload,
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
import {
  ensureResizeObserver,
  installApiMock,
  type SyncHarness,
} from "./helpers/sync-harness";

let syncHarness: SyncHarness;

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
  ensureResizeObserver();
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

    // The store (plus the card's upload-job toaster, which also subscribes
    // to window.api.sync.onEvent per migrate-upload §13.4) must have
    // registered their onEvent listeners on mount before we synthesise
    // events — assert at-least-once rather than an exact count.
    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalled();
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
      expect(syncHarness.onEvent).toHaveBeenCalled();
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
      expect(syncHarness.onEvent).toHaveBeenCalled();
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
