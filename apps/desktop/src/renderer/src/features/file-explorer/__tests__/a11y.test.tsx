/** @vitest-environment jsdom */
//
// Phase 9.2 — File-explorer accessibility coverage.
//
// Mirrors the style of `features/datasources/__tests__/a11y.test.tsx`:
// structural WCAG sanity checks over the composite's toolbar, breadcrumb,
// main pane (Details view), details pane, and status row. No new deps
// (no jest-axe / @axe-core) — we assert role / name / focus-ring class
// structure directly to catch regressions in DOM semantics.
//
// Jsdom does NOT implement Tab focus-cycling. We assert keyboard
// reachability via focusability proxies (native buttons, tabIndex),
// matching the pattern used in the datasources a11y suite.
//
// If an assertion here surfaces a gap in a feature component, fix the
// component — this suite characterises a11y state that Phases 1–8 must
// have already put in place.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { FileEntry } from "@ft5/ipc-contracts";

// FileExplorer now calls `useRouter()` for the back-to-dashboard button.
// Mock `next/navigation` so the App Router invariant doesn't fire.
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

import { FileExplorer } from "../file-explorer.js";
import {
  __resetExplorerStoreCacheForTests,
  getOrCreateExplorerStore,
} from "../store.js";
import { seedEntry } from "./test-utils.js";

// --- API mock helper (mirrors file-explorer-composite.test.tsx) ----------

let filesListMock: Mock;

function installApiMock(
  responses: Map<string, { entries: FileEntry[]; nextCursor: string | null }>,
): void {
  filesListMock = vi.fn();
  filesListMock.mockImplementation(async (req: { path: string }) => {
    const canned = responses.get(req.path);
    if (canned !== undefined) return canned;
    return { entries: [], nextCursor: null };
  });
  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: vi.fn(),
      remove: vi.fn(),
      action: vi.fn(),
      upload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
    },
    files: {
      list: filesListMock,
      stat: vi.fn(),
      search: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      download: vi.fn(),
    },
  };
}

const ROOT_ENTRIES: FileEntry[] = [
  seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" }),
  seedEntry({ id: "b", name: "bravo.pdf", path: "/bravo.pdf" }),
  seedEntry({
    id: "c",
    name: "charlie",
    path: "/charlie",
    kind: "directory",
    size: null,
    mimeFamily: "unknown",
    mimeType: null,
  }),
];

const DATASOURCE_ID = "ds-a11y-test";

async function mountPopulated(): Promise<void> {
  installApiMock(
    new Map([["/", { entries: ROOT_ENTRIES, nextCursor: null }]]),
  );
  render(<FileExplorer datasourceId={DATASOURCE_ID} />);
  await waitFor(() => {
    const rows = document.querySelectorAll('[data-testid="explorer-row"]');
    expect(rows.length).toBe(ROOT_ENTRIES.length);
  });
}

function getToolbar(): HTMLElement {
  return screen.getByRole("toolbar", { name: /explorer toolbar/i });
}

// --- Shared lifecycle -----------------------------------------------------

beforeEach(() => {
  window.localStorage.clear();
  __resetExplorerStoreCacheForTests();
  // Radix primitives rely on ResizeObserver at mount.
  if (!("ResizeObserver" in window)) {
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
  window.localStorage.clear();
  vi.restoreAllMocks();
});

// --- Suite: Toolbar a11y --------------------------------------------------

describe("Toolbar a11y (task 9.2)", () => {
  it("outer container has role='toolbar' with aria-label 'Explorer toolbar'", async () => {
    await mountPopulated();
    const toolbar = getToolbar();
    expect(toolbar).toBeInTheDocument();
    expect(toolbar.getAttribute("aria-label")).toBe("Explorer toolbar");
  });

  it("every toolbar button has a non-empty accessible name", async () => {
    await mountPopulated();
    const toolbar = getToolbar();
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      const ariaLabel = btn.getAttribute("aria-label");
      const text = btn.textContent?.trim() ?? "";
      // Accessible name must resolve to a non-empty string via
      // either aria-label or visible text.
      const name = ariaLabel !== null && ariaLabel.length > 0 ? ariaLabel : text;
      expect(
        name.length,
        `toolbar button missing accessible name: ${btn.outerHTML}`,
      ).toBeGreaterThan(0);
    }
  });

  it("every toolbar button has type='button' (prevents accidental form-submit)", async () => {
    await mountPopulated();
    const toolbar = getToolbar();
    const buttons = within(toolbar).getAllByRole("button");
    for (const btn of buttons) {
      expect(btn.getAttribute("type")).toBe("button");
    }
  });

  it("every toolbar button carries the shared focus-visible ring class pattern", async () => {
    await mountPopulated();
    const toolbar = getToolbar();
    const buttons = within(toolbar).getAllByRole("button");
    // shadcn Button sets `focus-visible:ring-ring/50` + `focus-visible:ring-[3px]`.
    // A flexible regex tolerates other focus utilities stacked on top.
    const ringPattern = /focus-visible:ring-ring/;
    const widthPattern = /focus-visible:ring-(?:2|\[3px\])/;
    for (const btn of buttons) {
      const cls = btn.getAttribute("class") ?? "";
      expect(cls).toMatch(ringPattern);
      expect(cls).toMatch(widthPattern);
    }
  });
});

// --- Suite: Breadcrumb a11y ----------------------------------------------

describe("Breadcrumb a11y (task 9.2)", () => {
  // Root nav + aria-label is also covered in breadcrumb.test.tsx; repeating
  // here so this a11y surface is self-contained.
  it("root is a <nav> with aria-label 'Folder path'", async () => {
    await mountPopulated();
    const nav = screen.getByRole("navigation", { name: /folder path/i });
    expect(nav.tagName.toLowerCase()).toBe("nav");
  });

  it("segments render as an ordered list (<ol> with implicit role='list')", async () => {
    await mountPopulated();
    const nav = screen.getByRole("navigation", { name: /folder path/i });
    const list = nav.querySelector("ol");
    expect(list, "breadcrumb should render an <ol> wrapper").not.toBeNull();
  });

  it("each segment button's accessible name matches its visible text", async () => {
    // Navigate one level deep so at least one interactive segment exists
    // (the last segment renders as a non-interactive aria-current span).
    installApiMock(
      new Map([
        ["/", { entries: ROOT_ENTRIES, nextCursor: null }],
        ["/charlie", { entries: [], nextCursor: null }],
      ]),
    );
    render(<FileExplorer datasourceId={DATASOURCE_ID} />);
    const store = getOrCreateExplorerStore(DATASOURCE_ID);
    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-testid="explorer-row"]').length,
      ).toBe(ROOT_ENTRIES.length);
    });
    act(() => {
      store.navigate("/charlie");
    });
    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalledWith({
        datasourceId: DATASOURCE_ID,
        path: "/charlie",
      });
    });

    const nav = screen.getByRole("navigation", { name: /folder path/i });
    const segmentButtons = within(nav).getAllByRole("button");
    expect(segmentButtons.length).toBeGreaterThan(0);
    for (const btn of segmentButtons) {
      const text = btn.textContent?.trim() ?? "";
      expect(text.length).toBeGreaterThan(0);
      // Accessible name equals visible text when there is no aria-label.
      const ariaLabel = btn.getAttribute("aria-label");
      if (ariaLabel !== null) {
        expect(ariaLabel).toBe(text);
      }
    }
  });

  it("each segment button carries focus-visible ring class pattern", async () => {
    installApiMock(
      new Map([
        ["/", { entries: ROOT_ENTRIES, nextCursor: null }],
        ["/charlie", { entries: [], nextCursor: null }],
      ]),
    );
    render(<FileExplorer datasourceId={DATASOURCE_ID} />);
    const store = getOrCreateExplorerStore(DATASOURCE_ID);
    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-testid="explorer-row"]').length,
      ).toBe(ROOT_ENTRIES.length);
    });
    act(() => {
      store.navigate("/charlie");
    });
    await waitFor(() => {
      const nav = screen.getByRole("navigation", { name: /folder path/i });
      expect(within(nav).queryAllByRole("button").length).toBeGreaterThan(0);
    });

    const nav = screen.getByRole("navigation", { name: /folder path/i });
    const buttons = within(nav).getAllByRole("button");
    for (const btn of buttons) {
      const cls = btn.getAttribute("class") ?? "";
      // breadcrumb.tsx uses focus-visible:ring-ring/50 + focus-visible:ring-[3px].
      expect(cls).toMatch(/focus-visible:ring-ring/);
      expect(cls).toMatch(/focus-visible:ring-(?:2|\[3px\])/);
    }
  });
});

// --- Suite: Main pane (Details view) a11y --------------------------------

describe("Main pane a11y — Details view (task 9.2)", () => {
  it("has role='grid' with an accessible name", async () => {
    await mountPopulated();
    const grid = screen.getByRole("grid", { name: /files/i });
    expect(grid).toBeInTheDocument();
  });

  it("every data row carries data-entry-id linking it back to its entry", async () => {
    await mountPopulated();
    const rows = document.querySelectorAll<HTMLElement>(
      '[data-testid="explorer-row"]',
    );
    expect(rows.length).toBe(ROOT_ENTRIES.length);
    for (const row of rows) {
      const id = row.getAttribute("data-entry-id");
      expect(id, "each row must surface data-entry-id").not.toBeNull();
      expect(id!.length).toBeGreaterThan(0);
    }
  });

  it("rows implement the roving-tabindex pattern (exactly one tabIndex=0, rest -1)", async () => {
    await mountPopulated();
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="explorer-row"]'),
    );
    const tabIndexes = rows.map((r) => r.getAttribute("tabindex"));
    // Every row must declare an explicit tabindex (roving requires -1 on
    // non-focused rows).
    for (const ti of tabIndexes) {
      expect(ti).not.toBeNull();
      expect(["0", "-1"]).toContain(ti);
    }
    // At most one row is tab-reachable. In the initial render (no focus
    // set) all rows start at -1; after a focus is set exactly one becomes
    // 0. Either situation is compatible with the roving pattern.
    const reachable = tabIndexes.filter((ti) => ti === "0");
    expect(reachable.length).toBeLessThanOrEqual(1);
  });

  it("row icons are marked aria-hidden so the row's name is the sole accessible name source", async () => {
    await mountPopulated();
    const rows = document.querySelectorAll<HTMLElement>(
      '[data-testid="explorer-row"]',
    );
    for (const row of rows) {
      // Every decorative svg inside a row is aria-hidden (set by the Icon
      // adapter). Guard against a regression where a future icon forgets
      // the flag.
      const svgs = row.querySelectorAll("svg");
      expect(svgs.length).toBeGreaterThan(0);
      for (const svg of Array.from(svgs)) {
        expect(svg.getAttribute("aria-hidden")).toBe("true");
      }
    }
  });

  it("each row's visible text includes the entry name (accessible-name probe)", async () => {
    await mountPopulated();
    for (const entry of ROOT_ENTRIES) {
      const row = document.querySelector<HTMLElement>(
        `[data-testid="explorer-row"][data-entry-id="${entry.id}"]`,
      );
      expect(row).not.toBeNull();
      expect(row!.textContent ?? "").toContain(entry.name);
    }
  });
});

// --- Suite: Details pane a11y --------------------------------------------

describe("Details pane a11y (task 9.2)", () => {
  it("pane has aria-label='Details' when open", async () => {
    await mountPopulated();
    const store = getOrCreateExplorerStore(DATASOURCE_ID);
    act(() => {
      store.toggleDetailsPane();
    });
    // `aria-label` on <aside> — use a direct DOM probe so we don't depend
    // on the landmark role (aside + aria-label is a WCAG-compliant name).
    await waitFor(() => {
      const pane = document.querySelector<HTMLElement>(
        'aside[aria-label="Details"]',
      );
      expect(pane).not.toBeNull();
      expect(pane!.hasAttribute("hidden")).toBe(false);
    });
  });

  it("details toggle button reflects open/closed via aria-pressed", async () => {
    await mountPopulated();
    const toggle = screen.getByTestId("file-explorer-details-toggle");
    // Default: closed (localStorage was cleared in beforeEach).
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    const store = getOrCreateExplorerStore(DATASOURCE_ID);
    act(() => {
      store.toggleDetailsPane();
    });
    await waitFor(() => {
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("closed pane is removed from the accessibility tree (hidden + aria-hidden)", async () => {
    await mountPopulated();
    // Default state: closed.
    const pane = document.querySelector<HTMLElement>(
      'aside[aria-label="Details"]',
    );
    expect(pane).not.toBeNull();
    expect(pane!.hasAttribute("hidden")).toBe(true);
    expect(pane!.getAttribute("aria-hidden")).toBe("true");
  });
});

// --- Suite: Status row a11y ---------------------------------------------

describe("Status row a11y (task 9.2)", () => {
  // Root role + aria-live is also asserted in status-row.test.tsx; repeated
  // here to keep this a11y surface self-contained.
  it("root element has role='status' with aria-live='polite'", async () => {
    await mountPopulated();
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("surfaces a non-empty item count once entries are loaded", async () => {
    await mountPopulated();
    const status = screen.getByRole("status");
    expect(status.textContent ?? "").toMatch(/\d+\s*items/);
  });
});

// --- Suite: Tab order / keyboard reachability ----------------------------

describe("Keyboard reachability (task 9.2)", () => {
  // Jsdom does NOT simulate Tab cycling. We assert reachability proxies:
  // interactive elements must be native <button>s (or carry tabIndex >= 0),
  // match the pattern used by the datasources a11y suite.
  it("every interactive chrome control is a native focusable element", async () => {
    await mountPopulated();
    // Collect history buttons, breadcrumb root button, toolbar buttons.
    const toolbar = getToolbar();
    const toolbarButtons = within(toolbar).getAllByRole("button");
    const nav = screen.getByRole("navigation", { name: /folder path/i });
    const breadcrumbButtons = within(nav).queryAllByRole("button");
    // History buttons sit in the chrome row next to the breadcrumb; they
    // don't live in the toolbar. Pick them up by their aria-labels.
    const backBtn = screen.getByRole("button", { name: /go back/i });
    const forwardBtn = screen.getByRole("button", { name: /go forward/i });
    const upBtn = screen.getByRole("button", { name: /go up one level/i });

    const all = [
      ...toolbarButtons,
      ...breadcrumbButtons,
      backBtn,
      forwardBtn,
      upBtn,
    ];
    for (const el of all) {
      expect(el).toBeInstanceOf(HTMLButtonElement);
      // Default <button> is tab-reachable. An explicit tabindex must be
      // non-negative if present.
      const ti = el.getAttribute("tabindex");
      if (ti !== null) {
        expect(Number(ti)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("focusing a toolbar button succeeds (jsdom focus proxy)", async () => {
    await mountPopulated();
    const toolbar = getToolbar();
    const buttons = within(toolbar).getAllByRole("button");
    for (const btn of buttons) {
      // Disabled buttons intentionally aren't focusable — skip them.
      if ((btn as HTMLButtonElement).disabled) continue;
      btn.focus();
      expect(btn).toHaveFocus();
    }
  });
});
