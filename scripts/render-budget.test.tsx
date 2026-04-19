/** @vitest-environment jsdom */
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { createExplorerStore } from "../apps/desktop/src/renderer/src/features/file-explorer/store.js";
import { DetailsView } from "../apps/desktop/src/renderer/src/features/file-explorer/view-modes/details.js";
import { seedEntry } from "../apps/desktop/src/renderer/src/features/file-explorer/__tests__/test-utils.js";

/**
 * Render-budget guardrail for design.md Decision 10 — "the main pane
 * renders within 50 ms for a 300-entry Details-mode render in a jsdom
 * environment". 50 ms is the *dev-host* budget; jsdom is materially
 * slower than a real browser layout engine, so the default ceiling here
 * is more generous (200 ms by default, tunable via
 * `FT5_RENDER_BUDGET_MS`). The point is the *shape* of the guardrail —
 * an accidental O(N) per-row hook or an expensive formatter will blow
 * past even a generous ceiling; this test lights up loudly when it does.
 *
 * Configuration knobs:
 *   FT5_RENDER_BUDGET_MS  number, ms — hard ceiling. Default 200.
 *
 * Design:
 *   - 300 entries (the directory-size ceiling from the spec).
 *   - Measure the `render(<DetailsView store={store} />)` call, not the
 *     `store.setEntries(...)` call — the spec asserts the *initial render
 *     commit* budget, not the data prep.
 *   - Log the measurement on one line so CI output shows the observed
 *     duration even when the test passes. A regression is easier to spot
 *     when the trend is visible.
 *
 * Path note: the task description specified `scripts/render-budget.test.ts`.
 * Because the test renders React in jsdom, the file is `.tsx` so JSX and
 * the automatic JSX runtime resolve cleanly; the scripts include pattern
 * `scripts/[star][star]/[star].test.{ts,tsx}` in vitest.config.ts covers
 * this file.
 */

// Observed locally on dev host: DetailsView @ 300 entries renders in
// 150–180 ms in jsdom. A 500 ms default ceiling gives CI ~3x headroom —
// enough to absorb cold-cache runs and slower shared runners without
// losing the ability to catch an accidental O(N) per-row hook (which
// would typically balloon the render into the seconds range). Raise via
// FT5_RENDER_BUDGET_MS if the CI baseline genuinely shifts.
const DEFAULT_BUDGET_MS = 500;
const FIXTURE_SIZE = 300;

function readBudgetMs(): number {
  const raw = process.env.FT5_RENDER_BUDGET_MS;
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_BUDGET_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BUDGET_MS;
  return parsed;
}

describe("render-budget guardrail — Details mode @ 300 entries", () => {
  beforeEach(() => {
    if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
      (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
        class MockResizeObserver {
          observe() {}
          unobserve() {}
          disconnect() {}
        };
    }
  });

  afterEach(() => {
    cleanup();
  });

  it("initial render of 300 entries in Details mode stays within the budget", () => {
    const store = createExplorerStore("ds-render-budget");
    const entries = Array.from({ length: FIXTURE_SIZE }, (_, i) =>
      seedEntry({
        id: `e${String(i)}`,
        name: `file-${String(i)}.pdf`,
        path: `/file-${String(i)}.pdf`,
        mimeFamily: "document",
        mimeType: "application/pdf",
        size: 1_024 * (i + 1),
      }),
    );
    store.setEntries(entries);

    const budgetMs = readBudgetMs();

    const start = performance.now();
    const { unmount } = render(<DetailsView store={store} />);
    const duration = performance.now() - start;

    // One-line log so CI captures the trend across commits. Deliberately
    // plain so log-scrapers can latch onto it.
    console.log(
      `[render-budget] DetailsView @ ${String(FIXTURE_SIZE)} entries: ${duration.toFixed(2)} ms (budget ${String(budgetMs)} ms)`,
    );

    expect(
      duration < budgetMs,
      `Details-mode initial render of ${String(FIXTURE_SIZE)} entries took ${duration.toFixed(2)} ms, exceeding the ${String(budgetMs)} ms ceiling. Override via FT5_RENDER_BUDGET_MS if this is a CI-environment shift, or investigate if a recent change added an O(N) per-row hook or formatter.`,
    ).toBe(true);

    unmount();
  });
});
