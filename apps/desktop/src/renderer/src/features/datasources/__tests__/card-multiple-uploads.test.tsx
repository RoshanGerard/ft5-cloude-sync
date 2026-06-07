/** @vitest-environment jsdom */
//
// Phase 10 task 10.5 (RED) — DatasourceCard active-upload tiebreak.
//
// Per design.md Decision 13 ("What — progress bar visibility"), when more
// than one upload-kind job is in flight on the same datasource, the bar
// renders for the ACTIVE job — chosen by `createdAt desc, then jobId lex
// desc` (the spec was amended in commit 2a23c63 from `startedAt` to
// `createdAt` since `JobSummary` has no `startedAt` field and `updatedAt` is
// overwritten on every `job-progress` tick, making it unstable for ordering).
//
// `createdAt` is sourced from the `job-enqueued` event's `enqueuedAt`. The
// useDatasourceUploadProgress() selector (store.tsx) implements the tiebreak.
//
// What this file asserts (translated from tasks.md 10.5):
//   1. Bar tracks the NEWER job when two upload jobs are in flight.
//   2. Bar SWITCHES to the older job when the newer one completes.
//   3. Bar UNMOUNTS when both jobs complete.
//   4. Lex-desc tiebreak when `createdAt` ties exactly (jobId-desc wins).
//
// 10.4's GREEN already implements this tiebreak verbatim per the amended
// Decision 13 (createdAt desc, then id lex desc). So 10.5 may pass on
// arrival ("GREEN-on-arrival"); 10.6 GREEN then becomes a verification-only
// no-op. That outcome is acceptable per the harness instructions — the test
// is written truthfully against the spec, not contrived to fail.

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
// none of these tests activate Explore. Same hoisted-mock pattern as
// card-sync-state.test.tsx + card-upload-progress.test.tsx.
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

const DS_ID = "ds-1";

function buildSummary(
  overrides: Partial<DatasourceSummary> = {},
): DatasourceSummary {
  return {
    id: DS_ID,
    displayName: "Multi-upload Drive",
    providerId: "google-drive",
    status: "connected",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 0,
    usage: undefined,
    ...overrides,
  };
}

interface EnqueueOverrides {
  jobId: string;
  enqueuedAt: number;
}

function enqueuedPayload(o: EnqueueOverrides): JobEnqueuedPayload {
  return {
    jobId: o.jobId,
    kind: "upload",
    datasourceId: DS_ID,
    sourcePath: `/local/${o.jobId}.bin`,
    targetPath: `/remote/${o.jobId}.bin`,
    conflictPolicy: "overwrite",
    enqueuedAt: o.enqueuedAt,
  };
}

function startedPayload(jobId: string, startedAt: number): JobStartedPayload {
  return { jobId, attempt: 1, startedAt };
}

function progressPayload(
  jobId: string,
  percent: number,
  totalBytes = 1000,
): JobProgressPayload {
  return {
    jobId,
    bytesSent: Math.round((percent / 100) * totalBytes),
    totalBytes,
    percent,
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

describe("DatasourceCard — multiple in-flight uploads (Decision 13 tiebreak)", () => {
  it("bar tracks the newer job when two upload jobs are in flight", async () => {
    renderWithProvider(<DatasourceCard summary={buildSummary()} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalled();
    });

    const seed: SyncStateSeedPayload = { jobs: [] };
    syncHarness.emit({ kind: "sync-state-seed", payload: seed });

    // Two upload jobs, enqueued 1ms apart. j-new is the newer one (higher
    // createdAt → wins the tiebreak).
    syncHarness.emit({
      kind: "job-enqueued",
      payload: enqueuedPayload({
        jobId: "j-old",
        enqueuedAt: 1_700_000_000_000,
      }),
    });
    syncHarness.emit({
      kind: "job-enqueued",
      payload: enqueuedPayload({
        jobId: "j-new",
        enqueuedAt: 1_700_000_000_001,
      }),
    });
    syncHarness.emit({
      kind: "job-started",
      payload: startedPayload("j-old", 1_700_000_000_010),
    });
    syncHarness.emit({
      kind: "job-started",
      payload: startedPayload("j-new", 1_700_000_000_011),
    });

    // One progress tick for the newer job at 50%.
    syncHarness.emit({
      kind: "job-progress",
      payload: progressPayload("j-new", 50),
    });

    await waitFor(() => {
      const bar = screen.getByTestId("datasource-upload-progress");
      expect(bar.getAttribute("data-job-id")).toBe("j-new");
      expect(bar.getAttribute("aria-valuenow")).toBe("50");
    });
  });

  it("bar switches to the older job when the newer one completes", async () => {
    renderWithProvider(<DatasourceCard summary={buildSummary()} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalled();
    });

    syncHarness.emit({ kind: "sync-state-seed", payload: { jobs: [] } });
    syncHarness.emit({
      kind: "job-enqueued",
      payload: enqueuedPayload({
        jobId: "j-old",
        enqueuedAt: 1_700_000_000_000,
      }),
    });
    syncHarness.emit({
      kind: "job-enqueued",
      payload: enqueuedPayload({
        jobId: "j-new",
        enqueuedAt: 1_700_000_000_001,
      }),
    });
    syncHarness.emit({
      kind: "job-started",
      payload: startedPayload("j-old", 1_700_000_000_010),
    });
    syncHarness.emit({
      kind: "job-started",
      payload: startedPayload("j-new", 1_700_000_000_011),
    });
    syncHarness.emit({
      kind: "job-progress",
      payload: progressPayload("j-new", 50),
    });

    await waitFor(() => {
      const bar = screen.getByTestId("datasource-upload-progress");
      expect(bar.getAttribute("data-job-id")).toBe("j-new");
    });

    // Progress tick for the older job. The bar should still show j-new
    // (the newer one wins the tiebreak unchanged).
    syncHarness.emit({
      kind: "job-progress",
      payload: progressPayload("j-old", 25),
    });
    await waitFor(() => {
      const bar = screen.getByTestId("datasource-upload-progress");
      expect(bar.getAttribute("data-job-id")).toBe("j-new");
      expect(bar.getAttribute("aria-valuenow")).toBe("50");
    });

    // Now complete the newer job. The bar must switch to j-old, showing
    // its last recorded progress (25%).
    syncHarness.emit({
      kind: "job-completed",
      payload: { jobId: "j-new", completedAt: 1_700_000_000_500 },
    });

    await waitFor(() => {
      const bar = screen.getByTestId("datasource-upload-progress");
      expect(bar.getAttribute("data-job-id")).toBe("j-old");
      expect(bar.getAttribute("aria-valuenow")).toBe("25");
    });
  });

  it("bar unmounts when both jobs complete", async () => {
    renderWithProvider(<DatasourceCard summary={buildSummary()} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalled();
    });

    syncHarness.emit({ kind: "sync-state-seed", payload: { jobs: [] } });
    syncHarness.emit({
      kind: "job-enqueued",
      payload: enqueuedPayload({
        jobId: "j-old",
        enqueuedAt: 1_700_000_000_000,
      }),
    });
    syncHarness.emit({
      kind: "job-enqueued",
      payload: enqueuedPayload({
        jobId: "j-new",
        enqueuedAt: 1_700_000_000_001,
      }),
    });
    syncHarness.emit({
      kind: "job-started",
      payload: startedPayload("j-old", 1_700_000_000_010),
    });
    syncHarness.emit({
      kind: "job-started",
      payload: startedPayload("j-new", 1_700_000_000_011),
    });
    syncHarness.emit({
      kind: "job-progress",
      payload: progressPayload("j-new", 50),
    });
    syncHarness.emit({
      kind: "job-progress",
      payload: progressPayload("j-old", 25),
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("datasource-upload-progress"),
      ).toBeInTheDocument();
    });

    syncHarness.emit({
      kind: "job-completed",
      payload: { jobId: "j-new", completedAt: 1_700_000_000_500 },
    });
    syncHarness.emit({
      kind: "job-completed",
      payload: { jobId: "j-old", completedAt: 1_700_000_000_600 },
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("datasource-upload-progress"),
      ).not.toBeInTheDocument();
    });
  });

  it("falls back to lex-desc on jobId when createdAt ties exactly", async () => {
    renderWithProvider(<DatasourceCard summary={buildSummary()} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalled();
    });

    syncHarness.emit({ kind: "sync-state-seed", payload: { jobs: [] } });

    // Both enqueued at the EXACT same instant. Tiebreak per Decision 13:
    // createdAt desc (tie), then jobId lex desc. "j-zzz" > "j-aaa" lex,
    // so j-zzz wins.
    const sameMoment = 1_700_000_000_000;
    syncHarness.emit({
      kind: "job-enqueued",
      payload: enqueuedPayload({ jobId: "j-aaa", enqueuedAt: sameMoment }),
    });
    syncHarness.emit({
      kind: "job-enqueued",
      payload: enqueuedPayload({ jobId: "j-zzz", enqueuedAt: sameMoment }),
    });
    syncHarness.emit({
      kind: "job-started",
      payload: startedPayload("j-aaa", sameMoment + 1),
    });
    syncHarness.emit({
      kind: "job-started",
      payload: startedPayload("j-zzz", sameMoment + 2),
    });
    syncHarness.emit({
      kind: "job-progress",
      payload: progressPayload("j-zzz", 75),
    });

    await waitFor(() => {
      const bar = screen.getByTestId("datasource-upload-progress");
      expect(bar.getAttribute("data-job-id")).toBe("j-zzz");
      expect(bar.getAttribute("aria-valuenow")).toBe("75");
    });
  });
});
