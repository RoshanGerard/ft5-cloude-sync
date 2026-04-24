/** @vitest-environment jsdom */
//
// Phase 10 task 10.7 (RED) — DatasourceCard waiting-network visual variant.
//
// Per design.md Decision 13's "Visual variant — waiting-network" subsection,
// when a `kind === "sync"` job for this datasource transitions to status
// `"waiting-network"` the status pill must:
//
//   1. stay the syncing variant (default badge with the SyncingDot), but
//      swap the dot's `currentColor` from amber to ZINC;
//   2. add a small lucide `wifi-off` icon LEFT of the status text;
//   3. update the accessible name to `Status: waiting for network`;
//   4. announce the transition via an ARIA-live polite region (the badge
//      itself MAY carry `aria-live="polite"` — a separate sibling region
//      is not mandated).
//
// Today (HEAD = 61254fb) `deriveDisplayStatus` collapses
// `hasWaitingNetwork` → `"syncing"` and `StatusBadge` only branches on
// `DatasourceStatus`, so cases 1–4 below MUST FAIL. Case 5 is a regression
// guard for 10.2's existing syncing badge (running sync-kind job → no
// wifi-off icon, label still "Syncing") and MUST PASS on arrival.
//
// Helper `seedWaitingNetwork` is defined inline (not pushed into
// helpers/sync-harness.tsx) per task 10.7's "DO NOT widen the helper
// module's surface" rule.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DatasourceSummary } from "@ft5/ipc-contracts";
import type {
  JobProgressPayload,
  JobSummary,
  SyncStateSeedPayload,
} from "@ft5/ipc-contracts/sync-service-desktop";

// next/navigation mock — DatasourceCard consumes `useRouter()` even though
// none of the tests below activate Explore. Same hoisted-mock pattern as
// the other section-10 tests.
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

/**
 * Drive a single sync-kind job for `datasourceId` into `waiting-network`
 * status by emitting a fresh `sync-state-seed` whose only job carries that
 * status. Today's reducer has no event that mutates an existing job's status
 * to `waiting-network`; a fresh seed is the cleanest path.
 */
function seedWaitingNetwork(
  harness: SyncHarness,
  jobId: string,
  datasourceId: string,
): void {
  const payload: SyncStateSeedPayload = {
    jobs: [
      buildJobSummary({
        id: jobId,
        kind: "sync",
        datasourceId,
        status: "waiting-network",
      }),
    ],
  };
  harness.emit({ kind: "sync-state-seed", payload });
}

beforeEach(() => {
  ensureResizeObserver();
  syncHarness = installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DatasourceCard — waiting-network visual variant (Decision 13)", () => {
  it("a waiting-network sync-kind job adds the wifi-off icon to the status badge", async () => {
    const summary = buildSummary({ id: "ds-1", status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    seedWaitingNetwork(syncHarness, "job-sync-ds1", "ds-1");

    // Decision 13: small lucide `wifi-off` icon LEFT of the status text,
    // inside the StatusBadge. Mirror card.tsx's provider-icon pattern of
    // exposing both `data-testid` and `data-icon` so tests assert on the
    // glyph identity, not the rendered SVG geometry.
    await waitFor(() => {
      const badge = screen.getByTestId("datasource-status");
      const icon = within(badge).getByTestId(
        "datasource-waiting-network-icon",
      );
      expect(icon).toHaveAttribute("data-icon", "wifi-off");
    });
  });

  it("the status badge accessible name reads 'waiting for network'", async () => {
    const summary = buildSummary({ id: "ds-1", status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    seedWaitingNetwork(syncHarness, "job-sync-ds1", "ds-1");

    // Decision 13 spells the accessible name as "Status: waiting for
    // network"; assert against the lowercased substring so 10.8 can iterate
    // the exact wording without breaking the RED test contract.
    await waitFor(() => {
      const badge = screen.getByTestId("datasource-status");
      const label = badge.getAttribute("aria-label") ?? "";
      expect(label.toLowerCase()).toMatch(/waiting for network/);
    });
  });

  it("the status badge text changes from 'Syncing' to a waiting-state label", async () => {
    const summary = buildSummary({ id: "ds-1", status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    seedWaitingNetwork(syncHarness, "job-sync-ds1", "ds-1");

    // Decision 13 doesn't pin the exact label text; assert the substring
    // `Waiting` (case-insensitive) so `Waiting`, `Waiting for network`,
    // and `Waiting…` all pass once 10.8 lands.
    await waitFor(() => {
      const badge = screen.getByTestId("datasource-status");
      const text = badge.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/waiting/);
    });
  });

  it("the transition emits an ARIA-live polite announcement", async () => {
    // Start with a running sync-kind job so the badge initially reads
    // `Syncing`, then drive a waiting-network seed to force the transition
    // through the reducer.
    const summary = buildSummary({ id: "ds-1", status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    const jobId = "job-sync-ds1";
    syncHarness.emit({
      kind: "sync-state-seed",
      payload: {
        jobs: [
          buildJobSummary({
            id: jobId,
            kind: "sync",
            datasourceId: "ds-1",
            status: "running",
          }),
        ],
      },
    });

    // Sanity: the badge starts in syncing (label "Syncing", no wifi-off).
    await waitFor(() => {
      const badge = screen.getByTestId("datasource-status");
      const text = badge.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/syncing/);
    });

    // A no-op job-progress tick that should NOT visibly change anything —
    // the reducer just bumps `updatedAt`. Included to prove the
    // announcement is driven by the status change, not by event volume.
    const progressPayload: JobProgressPayload = {
      jobId,
      bytesSent: 0,
      totalBytes: null,
      percent: null,
    };
    syncHarness.emit({ kind: "job-progress", payload: progressPayload });

    // Now drive the same jobId into waiting-network via a fresh seed (the
    // existing reducer has no event that mutates an existing job's status,
    // so a fresh seed is the cleanest path).
    seedWaitingNetwork(syncHarness, jobId, "ds-1");

    // Decision 13: the polite region MAY live on the badge itself
    // (`<Badge aria-live="polite" ...>`) — do NOT mandate a separate
    // sibling region. Look for any element with `aria-live="polite"`
    // whose text or aria-label reflects the waiting-network state.
    await waitFor(() => {
      const polite = document.querySelector('[aria-live="polite"]');
      expect(polite).not.toBeNull();
      const reflection =
        (polite?.getAttribute("aria-label") ?? "") +
        " " +
        (polite?.textContent ?? "");
      expect(reflection.toLowerCase()).toMatch(/waiting/);
    });
  });

  it("a running sync-kind job still renders the existing syncing badge (regression guard for 10.2)", async () => {
    // This case MUST PASS on arrival — it protects 10.2's behaviour against
    // 10.8 widening the badge too aggressively. With a running sync-kind
    // job, the badge label contains "Syncing" and there is NO wifi-off
    // icon present.
    const summary = buildSummary({ id: "ds-1", status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    await waitFor(() => {
      expect(syncHarness.onEvent).toHaveBeenCalledTimes(1);
    });

    syncHarness.emit({
      kind: "sync-state-seed",
      payload: {
        jobs: [
          buildJobSummary({
            id: "job-sync-ds1",
            kind: "sync",
            datasourceId: "ds-1",
            status: "running",
          }),
        ],
      },
    });

    await waitFor(() => {
      const badge = screen.getByTestId("datasource-status");
      const text = badge.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/syncing/);
    });

    expect(
      screen.queryByTestId("datasource-waiting-network-icon"),
    ).toBeNull();
  });
});
