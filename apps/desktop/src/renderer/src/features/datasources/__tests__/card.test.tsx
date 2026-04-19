/** @vitest-environment jsdom */
//
// Phase 5.3 — DatasourceCard test suite. Covers the spec scenarios (required
// fields, S3 omits usage bar, quick-action menu + keyboard behaviour, error
// status exposes the reason) plus visual-refinement sub-scenarios (p-4,
// tabular-nums, radar-ping sync animation, no backdrop-blur) and the
// provider-registry-driven icon lookup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DatasourceSummary } from "@ft5/ipc-contracts";
import { providers } from "@ft5/ipc-contracts";

import { DatasourceCard } from "../card";
import { DatasourcesProvider } from "../store";

// The card consumes `useDatasourceActions` from the provider, so we wrap
// every card render with a <DatasourcesProvider>. The provider in turn
// invokes `window.api.datasources.list()` on mount — we give it a never-
// resolving stub so the card settles in its rendered shape without the
// provider flipping into any other phase (and without pulling in real IPC).
function renderWithProvider(ui: ReactNode) {
  return render(<DatasourcesProvider>{ui}</DatasourcesProvider>);
}

function buildSummary(
  overrides: Partial<DatasourceSummary> = {},
): DatasourceSummary {
  return {
    id: "ds-test",
    displayName: "Test Drive",
    providerId: "google-drive",
    status: "connected",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 1234,
    usage: { used: 2_000_000_000, quota: 5_000_000_000 },
    ...overrides,
  };
}

// Polyfill ResizeObserver for jsdom — Radix DropdownMenu depends on it at
// mount; same pattern as the glass-overlay tests. Also install a mocked
// window.api so <DatasourcesProvider> can mount without throwing.
beforeEach(() => {
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      // A never-resolving list() keeps the provider in the `loading` phase
      // — the test cases render a <DatasourceCard> directly (not via the
      // dashboard), so the provider's own phase is irrelevant here; we just
      // need the actions hook to resolve to real callables.
      list: vi.fn().mockReturnValue(new Promise<never>(() => {})),
      add: vi.fn(),
      remove: vi.fn().mockResolvedValue({ ok: true }),
      action: vi.fn(),
      upload: vi.fn().mockResolvedValue({ transactionId: "tx-test" }),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DatasourceCard — spec scenarios", () => {
  it("renders all required fields for a non-null summary", () => {
    const summary = buildSummary();
    renderWithProvider(<DatasourceCard summary={summary} />);

    // Accessible heading with the display name.
    const heading = screen.getByRole("heading", { name: /test drive/i });
    expect(heading).toBeInTheDocument();

    // Provider icon — rendered as an <svg> inside the card's header region.
    // The provider registry maps google-drive → "cloud"; the rendered SVG
    // should be attributed with the matching data-icon so the icon is
    // queryable independent of the lucide internals.
    const providerIcon = document.querySelector(
      "[data-testid='datasource-provider-icon']",
    );
    expect(providerIcon).not.toBeNull();
    expect(providerIcon!.getAttribute("data-icon")).toBe(
      providers["google-drive"].icon,
    );

    // Status badge — accessible name contains the status word.
    const badge = screen.getByTestId("datasource-status");
    const badgeLabel =
      badge.getAttribute("aria-label") ?? badge.textContent ?? "";
    expect(badgeLabel.toLowerCase()).toMatch(/connected/);

    // Last-sync text.
    const lastSync = screen.getByTestId("datasource-last-sync");
    expect(lastSync.textContent).toBeTruthy();

    // Item count — reads the number somewhere in the card.
    const itemCount = screen.getByTestId("datasource-item-count");
    expect(itemCount.textContent).toMatch(/1[,.\s]?234/);

    // Quick-actions trigger — has an accessible name.
    const trigger = screen.getByRole("button", { name: /quick actions/i });
    expect(trigger).toBeInTheDocument();
  });

  it("renders 'never' when lastSyncAt is null", () => {
    const summary = buildSummary({ lastSyncAt: null });
    renderWithProvider(<DatasourceCard summary={summary} />);
    const lastSync = screen.getByTestId("datasource-last-sync");
    expect(lastSync.textContent?.toLowerCase()).toMatch(/never/);
  });

  it("S3 card omits the usage bar (capabilities.quota === false)", () => {
    const summary = buildSummary({
      id: "ds-s3",
      providerId: "amazon-s3",
      displayName: "Archive Bucket",
      usage: undefined,
    });
    const { container } = renderWithProvider(<DatasourceCard summary={summary} />);

    // No progressbar role anywhere on the card.
    expect(container.querySelector("[role='progressbar']")).toBeNull();
    // No usage-bar element.
    expect(container.querySelector("[data-testid='datasource-usage']")).toBeNull();
    // No used/quota text — we search for common GB/"quota"/"used" labels.
    const text = container.textContent ?? "";
    expect(text.toLowerCase()).not.toMatch(/used.*quota/);
  });

  it("quick-action menu exposes Sync now, Pause/Resume, Upload, Settings, Remove in order", async () => {
    const summary = buildSummary({ status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    const trigger = screen.getByRole("button", { name: /quick actions/i });
    fireEvent.pointerDown(trigger, { button: 0 });

    const items = await screen.findAllByRole("menuitem");
    const labels = items.map((i) => (i.textContent ?? "").trim());

    expect(labels.length).toBeGreaterThanOrEqual(5);
    expect(labels[0]).toMatch(/sync now/i);
    // Connected → action is "Pause".
    expect(labels[1]).toMatch(/pause/i);
    expect(labels[2]).toMatch(/upload/i);
    expect(labels[3]).toMatch(/settings/i);
    expect(labels[4]).toMatch(/remove/i);
  });

  it("Decision 15: every quick-action menu item has a leading SVG glyph", async () => {
    const summary = buildSummary({ status: "connected" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    const trigger = screen.getByRole("button", { name: /quick actions/i });
    fireEvent.pointerDown(trigger, { button: 0 });

    const items = await screen.findAllByRole("menuitem");
    // Five data-bearing items: Sync now, Pause/Resume, Upload, Settings,
    // Remove. Every one must render exactly one leading <svg> (the lucide
    // glyph) so the menu reads as iconic-CTA-consistent.
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const item of items) {
      const svgs = item.querySelectorAll("svg");
      expect(
        svgs.length,
        `menu item "${(item.textContent ?? "").trim()}" must render exactly one leading glyph`,
      ).toBe(1);
    }
  });

  it("quick-action label is Resume when status is paused", async () => {
    const summary = buildSummary({ status: "paused" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    const trigger = screen.getByRole("button", { name: /quick actions/i });
    fireEvent.pointerDown(trigger, { button: 0 });

    const items = await screen.findAllByRole("menuitem");
    const labels = items.map((i) => (i.textContent ?? "").trim());
    expect(labels[1]).toMatch(/resume/i);
  });

  it("error status: reason is in the DOM and in the badge's accessible name", () => {
    const summary = buildSummary({
      status: "error",
      errorReason: "Token expired",
    });
    const { container } = renderWithProvider(<DatasourceCard summary={summary} />);

    expect(container.textContent).toMatch(/Token expired/i);

    const badge = screen.getByTestId("datasource-status");
    const label =
      badge.getAttribute("aria-label") ?? badge.textContent ?? "";
    expect(label.toLowerCase()).toMatch(/error/);
    expect(label).toMatch(/Token expired/i);
  });
});

describe("DatasourceCard — visual refinement", () => {
  it("card root class list includes p-4 (density)", () => {
    const summary = buildSummary();
    renderWithProvider(<DatasourceCard summary={summary} />);
    const root = screen.getByTestId("datasource-card");
    expect(root.className).toMatch(/\bp-4\b/);
  });

  it("numeric fields are wrapped in tabular-nums elements", () => {
    const summary = buildSummary();
    renderWithProvider(<DatasourceCard summary={summary} />);

    const itemCount = screen.getByTestId("datasource-item-count");
    expect(itemCount.className).toMatch(/\btabular-nums\b/);

    const lastSync = screen.getByTestId("datasource-last-sync");
    expect(lastSync.className).toMatch(/\btabular-nums\b/);

    // Usage values — present for google-drive, carry tabular-nums.
    const usage = screen.getByTestId("datasource-usage");
    // Either the usage container itself or its digit-children carry tabular-nums.
    const usageRendersTabular =
      /\btabular-nums\b/.test(usage.className) ||
      Array.from(usage.querySelectorAll<HTMLElement>("*")).some((el) =>
        /\btabular-nums\b/.test(el.className),
      );
    expect(usageRendersTabular).toBe(true);
  });

  it("syncing status dot uses the radar-ping composition (pulse dot + ripple ring)", () => {
    const summary = buildSummary({ status: "syncing" });
    renderWithProvider(<DatasourceCard summary={summary} />);
    const dot = screen.getByTestId("datasource-syncing-dot");
    // Round-3: SyncingDot is now a two-circle SVG — the inner solid circle
    // keeps `motion-safe:animate-sync-pulse` (gentle opacity breathing),
    // and an outer ring uses `motion-safe:animate-sync-ripple` (expanding
    // radar ping). Read `class` attribute strings from each child circle;
    // SVGElement.className is an SVGAnimatedString, not a plain string.
    const circles = Array.from(dot.querySelectorAll<SVGCircleElement>("circle"));
    expect(circles.length).toBe(2);
    const classes = circles.map((c) => c.getAttribute("class") ?? "");
    const hasPulse = classes.some((c) => /\bmotion-safe:animate-sync-pulse\b/.test(c));
    const hasRipple = classes.some((c) => /\bmotion-safe:animate-sync-ripple\b/.test(c));
    expect(hasPulse).toBe(true);
    expect(hasRipple).toBe(true);
  });

  it("card root does NOT carry any backdrop-blur-* class (glass is overlays-only)", () => {
    const summary = buildSummary();
    const { container } = renderWithProvider(<DatasourceCard summary={summary} />);
    const root = screen.getByTestId("datasource-card");
    expect(root.className).not.toMatch(/\bbackdrop-blur/);
    // Also verify no descendants of the card root carry it (popovers like
    // the quick-actions menu are portalled to document.body, so they
    // wouldn't match this subtree query anyway).
    const descendants = root.querySelectorAll("*");
    for (const el of descendants) {
      expect(el.className.toString()).not.toMatch(/\bbackdrop-blur/);
    }
    // Sanity: the trigger/menu-content is portalled outside the card root,
    // so the card subtree itself stays glass-free.
    void container;
  });
});

describe("DatasourceCard — provider registry integration", () => {
  it("uses providers[providerId].icon via the Icon adapter (not hardcoded)", () => {
    // google-drive → "cloud"
    const { unmount: unmountGdrive } = renderWithProvider(
      <DatasourceCard summary={buildSummary({ providerId: "google-drive" })} />,
    );
    const gdriveIcon = document.querySelector(
      "[data-testid='datasource-provider-icon']",
    );
    expect(gdriveIcon!.getAttribute("data-icon")).toBe(
      providers["google-drive"].icon,
    );
    unmountGdrive();

    // onedrive → "cloud"
    const { unmount: unmountOnedrive } = renderWithProvider(
      <DatasourceCard summary={buildSummary({ providerId: "onedrive" })} />,
    );
    const onedriveIcon = document.querySelector(
      "[data-testid='datasource-provider-icon']",
    );
    expect(onedriveIcon!.getAttribute("data-icon")).toBe(
      providers.onedrive.icon,
    );
    unmountOnedrive();

    // amazon-s3 → "database"
    renderWithProvider(<DatasourceCard summary={buildSummary({ providerId: "amazon-s3" })} />);
    const s3Icon = document.querySelector(
      "[data-testid='datasource-provider-icon']",
    );
    expect(s3Icon!.getAttribute("data-icon")).toBe(providers["amazon-s3"].icon);
  });
});

describe("DatasourceCard — feature-level reduced-motion gating", () => {
  it("syncing dot is motion-safe-gated so prefers-reduced-motion kills the pulse", () => {
    // Stub matchMedia so any consumer that checks it sees reduce === true.
    const originalMatchMedia = window.matchMedia;
    (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia =
      vi.fn().mockImplementation((query: string) => ({
        matches: /prefers-reduced-motion:\s*reduce/.test(query),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

    const summary = buildSummary({ status: "syncing" });
    renderWithProvider(<DatasourceCard summary={summary} />);

    const dot = screen.getByTestId("datasource-syncing-dot");
    // Structural assertion: both motion utilities on the SyncingDot
    // composition (pulse on the inner dot, ripple on the outer ring)
    // must be motion-safe-gated so `prefers-reduced-motion: reduce`
    // users see no animation. jsdom does not actually evaluate the
    // Tailwind stylesheet, so we verify the class-list shape on each
    // child circle rather than `computed animation-duration` (empty
    // regardless of gating under jsdom).
    const circles = Array.from(dot.querySelectorAll<SVGCircleElement>("circle"));
    for (const c of circles) {
      const cls = c.getAttribute("class") ?? "";
      // Each child circle may carry one motion utility (or none, if it's
      // the static mid-layer). Whichever it carries, the bare form is
      // forbidden — it must be gated.
      expect(cls).not.toMatch(/(^|\s)animate-sync-pulse(\s|$)/);
      expect(cls).not.toMatch(/(^|\s)animate-sync-ripple(\s|$)/);
    }
    // And at least one circle DOES carry the gated pulse + one carries
    // the gated ripple — confirming the canonical authoring shape.
    const classes = circles.map((c) => c.getAttribute("class") ?? "");
    expect(classes.some((c) => /\bmotion-safe:animate-sync-pulse\b/.test(c))).toBe(true);
    expect(classes.some((c) => /\bmotion-safe:animate-sync-ripple\b/.test(c))).toBe(true);

    // Restore.
    (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia =
      originalMatchMedia;
    void within;
  });
});
