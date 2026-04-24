/** @vitest-environment jsdom */
//
// Phase 7.1 — Search UI (TDD red).
//
// Contract (from tasks.md 7.1):
//
//   "Toolbar search toggle opens an input, typing + Enter dispatches
//    `window.api.files.search`, results replace the main pane while a
//    'Clear search' affordance is visible."
//
// Swap-renderer model (Phase 7 Decision 1, locked): when
// `state.search.active === true`, the composite renders a `<SearchResults>`
// surface in place of `<ViewModeSwitcher>`. These tests assert the swap by
// test-id only — they do NOT import the not-yet-existing SearchResults
// module. All assertions are behavioural (contract, not layout), so they
// remain valid once 7.2/7.4 land.
//
// House style reminder: `@testing-library/user-event` is NOT a project dep
// (see tasks.md note at line 70). We use `fireEvent` + synthetic events,
// matching the existing toolbar / composite tests.

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
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { FileEntry } from "@ft5/ipc-contracts";
import { FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE } from "@ft5/ipc-contracts";

// FileExplorer now calls `useRouter()` for the back-to-dashboard button.
// Mock `next/navigation` so the App Router invariant doesn't fire under
// vitest. Push is a no-op — these tests assert explorer surface behaviour,
// not route navigation.
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

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let filesListMock: Mock;
let filesSearchMock: Mock;

interface InstallOptions {
  // Inner FilesListValue-shaped responses. The mock wraps each in the new
  // `{ ok: true, value: ... }` envelope. Legacy `nextCursor: null` is
  // retained on the inner type as a tolerated extra field so call-sites
  // that haven't been updated yet still typecheck — it's dropped in the
  // wrap step.
  listResponses?: Map<
    string,
    { entries: FileEntry[]; truncated?: boolean; nextCursor?: string | null }
  >;
  // Inner search-response. `providerSearchDeferred: true` is translated to
  // `{ ok: false, error: { tag: "other", message: <canonical> } }` at wrap
  // time so call-sites remain concise.
  searchResponse?: {
    entries: FileEntry[];
    truncated: boolean;
    providerSearchDeferred?: boolean;
  };
}

function installApiMock(options: InstallOptions = {}): void {
  filesListMock = vi.fn();
  const listResponses = options.listResponses ?? new Map();
  filesListMock.mockImplementation(async (req: { path: string }) => {
    const canned = listResponses.get(req.path);
    const inner = canned ?? { entries: [], truncated: false };
    return {
      ok: true as const,
      value: {
        entries: inner.entries,
        truncated: inner.truncated ?? false,
      },
    };
  });

  filesSearchMock = vi.fn();
  const searchInput = options.searchResponse ?? {
    entries: [],
    truncated: false,
  };
  const searchEnvelope = searchInput.providerSearchDeferred
    ? {
        ok: false as const,
        error: {
          tag: "other" as const,
          message: FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE,
          retryable: false,
        },
      }
    : {
        ok: true as const,
        value: {
          entries: searchInput.entries,
          truncated: searchInput.truncated,
        },
      };
  filesSearchMock.mockResolvedValue(searchEnvelope);

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
      search: filesSearchMock,
      rename: vi.fn(),
      remove: vi.fn(),
      download: vi.fn(),
    },
  };
}

// Radix portals (ContextMenu, DropdownMenu) need a ResizeObserver polyfill
// in jsdom — the toolbar.test.tsx establishes this pattern.
function installResizeObserverPolyfill(): void {
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileExplorer — search UI (Phase 7.1)", () => {
  beforeEach(() => {
    installResizeObserverPolyfill();
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("toolbar surfaces a Search control that opens a focused input", async () => {
    // Seed a single entry so the main pane resolves before we click Search.
    installApiMock({
      listResponses: new Map([
        ["/", { entries: [seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" })], nextCursor: null }],
      ]),
    });

    render(<FileExplorer datasourceId="ds-search-1" />);

    // Wait for initial load so we know we're looking at a stable composite.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    // The trigger is a toolbar button with an accessible name matching /search/i
    // and a stable test-id the impl will use.
    const trigger = screen.getByTestId("file-explorer-search-trigger");
    expect(trigger).toBeInTheDocument();
    expect(trigger.tagName).toBe("BUTTON");
    const triggerLabel =
      trigger.getAttribute("aria-label") ?? trigger.textContent ?? "";
    expect(triggerLabel.toLowerCase()).toMatch(/search/);

    // Activating it reveals a searchbox and focuses it.
    fireEvent.click(trigger);

    const input = await screen.findByRole("searchbox");
    expect(input).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("typing + Enter dispatches window.api.files.search with the typed query + path '/'", async () => {
    const hit = seedEntry({ id: "h1", name: "hit.txt", path: "/folder/hit.txt" });
    installApiMock({
      listResponses: new Map([
        ["/", { entries: [seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" })], nextCursor: null }],
      ]),
      searchResponse: { entries: [hit], truncated: false },
    });

    render(<FileExplorer datasourceId="ds-search-2" />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    fireEvent.click(screen.getByTestId("file-explorer-search-trigger"));

    const input = (await screen.findByRole("searchbox")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "hit" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(filesSearchMock).toHaveBeenCalledTimes(1);
    });
    expect(filesSearchMock).toHaveBeenCalledWith({
      datasourceId: "ds-search-2",
      query: "hit",
      path: "/",
    });
  });

  it("results replace the main pane: ViewModeSwitcher is gone, SearchResults is present", async () => {
    const hit = seedEntry({ id: "h1", name: "hit.txt", path: "/folder/hit.txt" });
    installApiMock({
      listResponses: new Map([
        ["/", { entries: [seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" })], nextCursor: null }],
      ]),
      searchResponse: { entries: [hit], truncated: false },
    });

    render(<FileExplorer datasourceId="ds-search-3" />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    fireEvent.click(screen.getByTestId("file-explorer-search-trigger"));
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "hit" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // After the search resolves, the default Details renderer's rows should
    // be gone (ViewModeSwitcher has been swapped out) and the SearchResults
    // surface should be mounted.
    await waitFor(() => {
      expect(screen.getByTestId("file-explorer-search-results")).toBeInTheDocument();
    });
    expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(0);
  });

  it("'Clear search' affordance is visible while search is active and dismisses the results", async () => {
    const hit = seedEntry({ id: "h1", name: "hit.txt", path: "/folder/hit.txt" });
    installApiMock({
      listResponses: new Map([
        ["/", { entries: [seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" })], nextCursor: null }],
      ]),
      searchResponse: { entries: [hit], truncated: false },
    });

    render(<FileExplorer datasourceId="ds-search-4" />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    fireEvent.click(screen.getByTestId("file-explorer-search-trigger"));
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "hit" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // SearchResults present → swap happened → search is active.
    await waitFor(() => {
      expect(screen.getByTestId("file-explorer-search-results")).toBeInTheDocument();
    });

    // Clear affordance is visible and accessibly named.
    const clearBtn = screen.getByTestId("file-explorer-search-clear");
    expect(clearBtn).toBeInTheDocument();
    expect(clearBtn.tagName).toBe("BUTTON");
    const clearLabel =
      clearBtn.getAttribute("aria-label") ?? clearBtn.textContent ?? "";
    expect(clearLabel.toLowerCase()).toMatch(/clear search/);

    fireEvent.click(clearBtn);

    // After clear: SearchResults is gone and ViewModeSwitcher output
    // (the default details row) is back.
    await waitFor(() => {
      expect(screen.queryByTestId("file-explorer-search-results")).toBeNull();
    });
    expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
  });

  it("clicking a search result opens its parent folder with the entry focused (Phase 7.4 integration)", async () => {
    // The spec scenario:
    //   "clicking an entry opens its parent folder with the entry focused"
    // This is the end-to-end click-navigate + focus-after-nav handoff:
    //   SearchResults.onResultActivate → composite stashes entry.id in
    //   pendingFocusRef → clearSearch + navigate(parentPath) → the
    //   subsequent `files.list` for parentPath resolves → the composite's
    //   drain-effect calls keyboardNav.setFocusedId(entry.id), which flips
    //   that row's `tabindex` from -1 to 0 under the roving-tabindex
    //   pattern established in Phase 4.4 (see
    //   view-modes/__tests__/list.test.tsx:112-135).
    const sibling = seedEntry({
      id: "p-design",
      name: "design.md",
      path: "/projects/docs/design.md",
      parentPath: "/projects/docs",
      mimeFamily: "text",
      mimeType: "text/markdown",
    });
    const target = seedEntry({
      id: "p-readme",
      name: "readme.md",
      path: "/projects/docs/readme.md",
      parentPath: "/projects/docs",
      mimeFamily: "text",
      mimeType: "text/markdown",
    });
    installApiMock({
      listResponses: new Map([
        [
          "/",
          {
            entries: [seedEntry({ id: "root-a", name: "alpha.png", path: "/alpha.png" })],
            nextCursor: null,
          },
        ],
        // Parent folder of the search hit — returned when the composite
        // navigates to `/projects/docs` after the result click.
        [
          "/projects/docs",
          {
            entries: [sibling, target],
            nextCursor: null,
          },
        ],
      ]),
      searchResponse: { entries: [target], truncated: false },
    });

    render(<FileExplorer datasourceId="ds-search-5" />);

    // Wait for the initial `/` load so the composite is stable.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    // Trigger search and submit.
    fireEvent.click(screen.getByTestId("file-explorer-search-trigger"));
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "read" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Wait for SearchResults to mount with our hit.
    await waitFor(() => {
      expect(screen.getByTestId("file-explorer-search-results")).toBeInTheDocument();
    });
    const resultRow = document.querySelector<HTMLElement>(
      '[data-testid="file-explorer-search-result"]',
    );
    expect(resultRow).not.toBeNull();

    // Click the result row → should clear search, navigate, and (once the
    // parent folder loads) focus the matching entry.
    fireEvent.click(resultRow!);

    // Search clears and the main pane swaps back to ViewModeSwitcher —
    // evidenced by the SearchResults surface vanishing and `explorer-row`
    // elements returning (now for `/projects/docs`, two of them).
    await waitFor(() => {
      expect(screen.queryByTestId("file-explorer-search-results")).toBeNull();
    });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(2);
    });

    // Focus-ring assertion via the roving-tabindex invariant from Phase
    // 4.4 (see list.test.tsx:112-135). Using `document.activeElement`
    // would rely on Radix focus-scope / jsdom behaviour that similar
    // tests in `context-menu.test.tsx` and `properties-modal.test.tsx`
    // call out as unreliable, so we assert the portable shape: the
    // target row's tabindex is "0" and the sibling row's is "-1".
    const targetRow = document.querySelector<HTMLElement>(
      `[data-testid="explorer-row"][data-entry-id="${target.id}"]`,
    );
    const siblingRow = document.querySelector<HTMLElement>(
      `[data-testid="explorer-row"][data-entry-id="${sibling.id}"]`,
    );
    expect(targetRow).not.toBeNull();
    expect(siblingRow).not.toBeNull();
    await waitFor(() => {
      expect(targetRow!.getAttribute("tabindex")).toBe("0");
    });
    expect(siblingRow!.getAttribute("tabindex")).toBe("-1");
  });

  // ---------------------------------------------------------------------
  // Phase 7.9 — Pre-search state restore (selection) + clean-clear on nav.
  //
  // Spec (file-explorer/spec.md, "Clearing the search restores the current
  // folder view"):
  //   ...selection that was in place before the search is restored;
  //   focus returns to the search-toggle control or the previously-
  //   focused entry.
  //
  // The load-bearing load-restore semantics the spec cares about is
  // *selection* — it's the piece the user will notice vanish if we don't
  // snapshot it. `focusedId` lives in `useKeyboardNav` (see
  // use-keyboard-nav.ts:38–42) and happens to persist across the
  // SearchResults ↔ ViewModeSwitcher swap today because the hook is
  // called unconditionally at `file-explorer.tsx:120`. A dedicated focus-
  // restore composite test would therefore pass by accident even without
  // the 7.10 snapshot wiring; the store-level idempotency + navigate-
  // drops-snapshot tests carry that semantic.
  //
  // This test drives the missing behaviour at the composite surface via
  // the public DOM + store handle: selection made before search must be
  // restored on explicit Clear even if it was mutated mid-search. Fails
  // today because `clearSearch()` does not restore the pre-search
  // selection snapshot. Implementation lands in task 7.10.
  // ---------------------------------------------------------------------

  it("clearing the search restores the pre-search selection (even if mutated mid-search)", async () => {
    const a = seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" });
    const b = seedEntry({ id: "b", name: "beta.png", path: "/beta.png" });
    const hit = seedEntry({
      id: "h1",
      name: "hit.txt",
      path: "/folder/hit.txt",
      parentPath: "/folder",
    });
    installApiMock({
      listResponses: new Map([
        ["/", { entries: [a, b], nextCursor: null }],
      ]),
      searchResponse: { entries: [hit], truncated: false },
    });

    render(<FileExplorer datasourceId="ds-search-7-9-restore" />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(2);
    });

    // Click row "a" to seed selection={a}. This is the real user path;
    // we rely on the DataRow click handler already in Phase 4 DOM.
    const aRow = document.querySelector<HTMLElement>(
      '[data-testid="explorer-row"][data-entry-id="a"]',
    );
    expect(aRow).not.toBeNull();
    fireEvent.click(aRow!);

    // aria-selected reflects selection; precondition for the restore
    // assertion further down.
    await waitFor(() => {
      const current = document.querySelector<HTMLElement>(
        '[data-testid="explorer-row"][data-entry-id="a"]',
      );
      expect(current?.getAttribute("aria-selected")).toBe("true");
    });

    // Activate search.
    fireEvent.click(screen.getByTestId("file-explorer-search-trigger"));
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "hit" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("file-explorer-search-results")).toBeInTheDocument();
    });

    // While search is active, simulate a mid-search selection mutation
    // (the SearchResults UI may call `store.select` on result click; we
    // drive the same state change via the store handle so the test is
    // not coupled to Phase 7.4's click handler wiring).
    const store = getOrCreateExplorerStore("ds-search-7-9-restore");
    act(() => {
      store.clearSelection();
    });

    // Click the Clear-search button.
    fireEvent.click(screen.getByTestId("file-explorer-search-clear"));

    // SearchResults gone, view mode rows back.
    await waitFor(() => {
      expect(screen.queryByTestId("file-explorer-search-results")).toBeNull();
    });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(2);
    });

    // Restore assertion: selection is back to {a}, regardless of the
    // mid-search `clearSelection()` call above. Assert via the DOM
    // (aria-selected) so the test stays decoupled from store internals.
    await waitFor(() => {
      const aAfter = document.querySelector<HTMLElement>(
        '[data-testid="explorer-row"][data-entry-id="a"]',
      );
      expect(aAfter?.getAttribute("aria-selected")).toBe("true");
    });
    const bAfter = document.querySelector<HTMLElement>(
      '[data-testid="explorer-row"][data-entry-id="b"]',
    );
    expect(bAfter?.getAttribute("aria-selected")).toBe("false");
  });

  it("navigating (via result click) while search is active clears search cleanly", async () => {
    // Regression guard (not a TDD red for 7.10). `handleSearchResultActivate`
    // (file-explorer.tsx:204-212) already calls `store.clearSearch()` as
    // of 7.4, so this scenario is green today. It exists to lock in the
    // "no orphaned search UI after navigate" invariant once 7.10's
    // snapshot/restore lands — a regression that re-activates search on
    // restore would flip this red. The companion store-level test
    // "navigate while search is active clears search AND drops the
    // snapshot" carries the actual TDD red for 7.10.
    const rootA = seedEntry({ id: "root-a", name: "alpha.png", path: "/alpha.png" });
    const target = seedEntry({
      id: "p-readme",
      name: "readme.md",
      path: "/projects/docs/readme.md",
      parentPath: "/projects/docs",
      mimeFamily: "text",
      mimeType: "text/markdown",
    });
    const sibling = seedEntry({
      id: "p-design",
      name: "design.md",
      path: "/projects/docs/design.md",
      parentPath: "/projects/docs",
      mimeFamily: "text",
      mimeType: "text/markdown",
    });
    installApiMock({
      listResponses: new Map([
        ["/", { entries: [rootA], nextCursor: null }],
        [
          "/projects/docs",
          { entries: [sibling, target], nextCursor: null },
        ],
      ]),
      searchResponse: { entries: [target], truncated: false },
    });

    render(<FileExplorer datasourceId="ds-search-7-9-nav" />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    // Start a search.
    fireEvent.click(screen.getByTestId("file-explorer-search-trigger"));
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "read" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("file-explorer-search-results")).toBeInTheDocument();
    });

    // Clicking the result triggers navigate(). Search must be cleared as
    // a side effect.
    const resultRow = document.querySelector<HTMLElement>(
      '[data-testid="file-explorer-search-result"]',
    );
    expect(resultRow).not.toBeNull();
    fireEvent.click(resultRow!);

    // Search dismissed, ViewModeSwitcher for the NEW folder is mounted.
    await waitFor(() => {
      expect(screen.queryByTestId("file-explorer-search-results")).toBeNull();
    });
    await waitFor(() => {
      // Two entries for /projects/docs (sibling + target).
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(2);
    });

    // Search trigger is present again (toolbar back to idle state) and
    // the searchbox input is gone — confirming a clean dismissal, not a
    // lingering-active-without-results state.
    expect(screen.getByTestId("file-explorer-search-trigger")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("Drive/OneDrive deferred response surfaces the deferred-work UI (Phase 7.8 integration)", async () => {
    // The handler returns `{ entries: [], truncated: true,
    // providerSearchDeferred: true }` for Drive/OneDrive datasources;
    // the composite must forward `providerKind="google-drive"` into
    // `<SearchResults>` so the deferred surface renders with the
    // provider-named copy. This is the end-to-end seam between the IPC
    // envelope, the store's `providerSearchDeferred` flag, and the UI's
    // deferred branch.
    installApiMock({
      listResponses: new Map([
        [
          "/",
          {
            entries: [seedEntry({ id: "root-a", name: "alpha.png", path: "/alpha.png" })],
            nextCursor: null,
          },
        ],
      ]),
      searchResponse: {
        entries: [],
        truncated: true,
        providerSearchDeferred: true,
      },
    });

    render(
      <FileExplorer datasourceId="ds-search-6" providerKind="google-drive" />,
    );

    // Wait for the initial load so the composite is stable.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    fireEvent.click(screen.getByTestId("file-explorer-search-trigger"));
    const input = await screen.findByRole("searchbox");
    fireEvent.change(input, { target: { value: "budget" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Deferred surface mounts with the provider-named copy + the Clear
    // button remains reachable.
    await waitFor(() => {
      expect(
        screen.getByTestId("file-explorer-search-deferred"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Native search for Google Drive is not available yet/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("file-explorer-search-clear")).toBeInTheDocument();
  });
});
