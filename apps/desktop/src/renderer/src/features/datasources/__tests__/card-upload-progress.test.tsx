/** @vitest-environment jsdom */
//
// Phase 10 task 10.3 (RED) — DatasourceCard upload-progress bar.
//
// Per design.md Decision 13 ("What — progress bar visibility"), the
// DatasourceCard renders a `<Progress>` bar IFF `jobsByDatasource[id]`
// contains at least one `kind === "upload"` job whose status is
// `running | queued | waiting-network`. The bar's value is computed from
// `uploadProgressByJob[activeUploadJobId]`:
//
//   if bytesTotal > 0 then Math.round(bytesUploaded / bytesTotal * 100)
//   else 0  (indeterminate state — bar renders at 0% until first sized tick)
//
// `uploadProgressByJob` is fed by the SAME `window.api.sync.onEvent`
// subscription that drives `jobsByDatasource` — specifically by `job-progress`
// events whose `jobId` belongs to a `kind === "upload"` job. Wire payload
// `bytesSent` / `totalBytes` map to `bytesUploaded` / `bytesTotal`. The bar
// unmounts naturally when the job is removed from `jobsByDatasource`
// (React reconciliation), NOT via an explicit unmount callback.
//
// Decision 13 also pins: upload-kind jobs do NOT change the status badge.
// Test 4 below sanity-checks that contract throughout the upload lifecycle.
//
// This file is the RED failing test that drives task 10.4 GREEN. It must
// FAIL today because:
//   1. card.tsx renders no Progress element with
//      data-testid="datasource-upload-progress" (the testid is invented here
//      and 10.4 is responsible for adopting it).
//   2. store.tsx's reducer does not dispatch into `uploadProgressByJob` from
//      `job-progress` events (the slice exists per 10.2, but the event-stream
//      wiring is left for 10.4).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DatasourceSummary } from "@ft5/ipc-contracts";
import type {
  JobEnqueuedPayload,
  JobProgressPayload,
  JobStartedPayload,
  SyncStateSeedPayload,
} from "@ft5/ipc-contracts/sync-service-desktop";

// next/navigation mock — DatasourceCard consumes `useRouter()` even though
// none of the tests below activate Explore. Same hoisted-mock pattern as
// card.test.tsx + card-sync-state.test.tsx.
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
  // Default datasource id for this file is `ds-2` (per task 10.3 wording),
  // distinguishing it from card-sync-state.test.tsx's `ds-1` so any cross-
  // test bleed via shared module state would surface as a clear mismatch.
  return {
    id: "ds-2",
    displayName: "Upload Test Drive",
    providerId: "google-drive",
    status: "connected",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 0,
    usage: undefined,
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

// Convenience: build the wire payloads for a single upload job's lifecycle.
const JOB_ID = "j-1";
const DS_ID = "ds-2";

function enqueuedPayload(): JobEnqueuedPayload {
  return {
    jobId: JOB_ID,
    kind: "upload",
    datasourceId: DS_ID,
    sourcePath: "/local/path/file.bin",
    targetPath: "/remote/path/file.bin",
    conflictPolicy: "overwrite",
    enqueuedAt: 1_700_000_000_100,
  };
}

function startedPayload(): JobStartedPayload {
  return {
    jobId: JOB_ID,
    attempt: 1,
    startedAt: 1_700_000_000_200,
  };
}

function progressPayload(percent: 25 | 50 | 75 | 100): JobProgressPayload {
  // Wire payload uses bytesSent / totalBytes (not bytesUploaded / bytesTotal);
  // the renderer's mapping rule per Decision 13 is bytesSent → bytesUploaded,
  // totalBytes → bytesTotal.
  return {
    jobId: JOB_ID,
    bytesSent: percent * 10, // 250, 500, 750, 1000
    totalBytes: 1000,
    percent,
  };
}

describe("DatasourceCard — upload-progress bar (Decision 13)", () => {
  it("renders the progress bar on upload-job presence after job-started", async () => {
    const summary = buildSummary({ id: DS_ID, status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    // Seed with no jobs.
    const seed: SyncStateSeedPayload = { jobs: [] };
    syncHarness.emit({ kind: "sync-state-seed", payload: seed });

    // No bar yet — no upload jobs in flight.
    expect(
      screen.queryByTestId("datasource-upload-progress"),
    ).not.toBeInTheDocument();

    // Enqueue + start the upload job. After job-started the bar must be
    // present even though no progress tick has arrived yet (the design
    // calls this the "indeterminate" state — value 0).
    syncHarness.emit({ kind: "job-enqueued", payload: enqueuedPayload() });
    syncHarness.emit({ kind: "job-started", payload: startedPayload() });

    await waitFor(() => {
      expect(
        screen.getByTestId("datasource-upload-progress"),
      ).toBeInTheDocument();
    });
  });

  it("updates the progress bar value to 25 / 50 / 75 / 100 across four ticks", async () => {
    const summary = buildSummary({ id: DS_ID, status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    syncHarness.emit({
      kind: "sync-state-seed",
      payload: { jobs: [] },
    });
    syncHarness.emit({ kind: "job-enqueued", payload: enqueuedPayload() });
    syncHarness.emit({ kind: "job-started", payload: startedPayload() });

    await waitFor(() => {
      expect(
        screen.getByTestId("datasource-upload-progress"),
      ).toBeInTheDocument();
    });

    // Radix Progress sets `aria-valuenow` on the role="progressbar" root —
    // see node_modules/@radix-ui/react-progress dist/index.mjs lines 33-39
    // (also exposes `data-value`, `data-state`, `data-max`, `aria-valuemax`,
    // `aria-valuemin`). We assert against `aria-valuenow` because it is the
    // accessibility-facing surface; a future shadcn primitive swap would be
    // required to keep ARIA semantics, while data-* are radix-internal.
    for (const pct of [25, 50, 75, 100] as const) {
      syncHarness.emit({
        kind: "job-progress",
        payload: progressPayload(pct),
      });
      await waitFor(() => {
        const bar = screen.getByTestId("datasource-upload-progress");
        expect(bar.getAttribute("aria-valuenow")).toBe(String(pct));
      });
    }
  });

  it("unmounts the progress bar on job-completed within one frame", async () => {
    const summary = buildSummary({ id: DS_ID, status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    syncHarness.emit({
      kind: "sync-state-seed",
      payload: { jobs: [] },
    });
    syncHarness.emit({ kind: "job-enqueued", payload: enqueuedPayload() });
    syncHarness.emit({ kind: "job-started", payload: startedPayload() });
    syncHarness.emit({
      kind: "job-progress",
      payload: progressPayload(50),
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("datasource-upload-progress"),
      ).toBeInTheDocument();
    });

    // Fire job-completed — the job leaves jobsByDatasource per 10.2's
    // reducer, and the bar's `if (uploadJobs.length > 0)` guard becomes
    // false, so React reconciliation unmounts the element. Decision 13
    // explicitly notes "no explicit unmount logic needed".
    syncHarness.emit({
      kind: "job-completed",
      payload: { jobId: JOB_ID, completedAt: 1_700_000_000_500 },
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("datasource-upload-progress"),
      ).not.toBeInTheDocument();
    });
  });

  it("upload-kind job does NOT change the status badge throughout its lifecycle", async () => {
    const summary = buildSummary({ id: DS_ID, status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    // Helper to assert the badge stays "connected" — Decision 13 spells out
    // that upload-kind jobs do NOT contribute to the status precedence rule.
    function expectBadgeConnected() {
      const badge = screen.getByTestId("datasource-status");
      const label =
        badge.getAttribute("aria-label") ?? badge.textContent ?? "";
      expect(label.toLowerCase()).toMatch(/connected/);
      // No syncing dot — that cue is reserved for sync-kind in-flight jobs.
      expect(screen.queryByTestId("datasource-syncing-dot")).toBeNull();
    }

    syncHarness.emit({
      kind: "sync-state-seed",
      payload: { jobs: [] },
    });
    expectBadgeConnected();

    syncHarness.emit({ kind: "job-enqueued", payload: enqueuedPayload() });
    expectBadgeConnected();

    syncHarness.emit({ kind: "job-started", payload: startedPayload() });
    expectBadgeConnected();

    for (const pct of [25, 50, 75, 100] as const) {
      syncHarness.emit({
        kind: "job-progress",
        payload: progressPayload(pct),
      });
      expectBadgeConnected();
    }

    syncHarness.emit({
      kind: "job-completed",
      payload: { jobId: JOB_ID, completedAt: 1_700_000_000_500 },
    });
    expectBadgeConnected();
  });
});
