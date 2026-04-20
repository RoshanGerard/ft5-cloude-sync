/** @vitest-environment jsdom */
//
// Phase 7.3 — SearchResults presentation (TDD red).
//
// Contract (from tasks.md 7.3):
//
//   "Each result shows the entry plus its parent path as a secondary line;
//    clicking a result navigates to the parent folder with the entry focused."
//
// This test isolates the `SearchResults` component (it does NOT mount the
// full `<FileExplorer>` — that's 7.1's composite test's job). It mirrors
// the unit-test style of `view-modes/__tests__/details.test.tsx`: a fresh
// `createExplorerStore(id)` per case, `render(<SearchResults store={...} />)`,
// assert rendered DOM + store reads.
//
// Today (Phase 7.2 stub) the SearchResults body is only `<li>{entry.name}</li>`
// + a Clear-search button. Assertions #2–#5 must fail semantically until 7.4
// lands the real presentation + click-to-navigate wiring + focusedId state.
//
// House style reminder: `@testing-library/user-event` is not a project dep;
// use `fireEvent` (see existing view-mode tests).
//

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  createExplorerStore,
  __resetExplorerStoreCacheForTests,
} from "../store.js";
import type { ExplorerStore } from "../store.js";
import { SearchResults } from "../search-results.js";
import { seedEntry } from "./test-utils.js";

function makeStore(id = "ds-search-results-test"): ExplorerStore {
  return createExplorerStore(id);
}

function seedSearchResults(store: ExplorerStore) {
  // Deliberately choose entries whose `name` has no text overlap with the
  // `parentPath`, so a `getByText(parentPath)` assertion cannot match the
  // name text by accident.
  const results = [
    seedEntry({
      id: "r-readme",
      kind: "file",
      name: "readme.md",
      path: "/projects/docs/readme.md",
      parentPath: "/projects/docs",
      mimeFamily: "text",
      mimeType: "text/markdown",
    }),
    seedEntry({
      id: "r-hero",
      kind: "file",
      name: "hero.png",
      path: "/assets/hero.png",
      parentPath: "/assets",
      mimeFamily: "image",
      mimeType: "image/png",
    }),
  ];
  act(() => {
    store.startSearch();
    store.setSearchQuery("re");
    store.setSearchResults(results, false);
  });
  return results;
}

function getResultRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="file-explorer-search-result"]',
    ),
  );
}

describe("SearchResults — presentation (7.3)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
    vi.restoreAllMocks();
  });

  it("renders one row per search result, each tagged with the per-row test-id", () => {
    const store = makeStore();
    seedSearchResults(store);

    render(<SearchResults store={store} />);

    const rows = getResultRows();
    expect(rows).toHaveLength(2);
  });

  it("each row shows the entry's name", () => {
    const store = makeStore();
    seedSearchResults(store);

    render(<SearchResults store={store} />);

    const rows = getResultRows();
    expect(within(rows[0]!).getByText("readme.md")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("hero.png")).toBeInTheDocument();
  });

  it("each row shows the parent path as a secondary text node, distinct from the name", () => {
    const store = makeStore();
    seedSearchResults(store);

    render(<SearchResults store={store} />);

    const rows = getResultRows();
    // The parent path text node must be present AND distinct from the name
    // element (asserted by comparing the two elements' identities).
    const firstRow = rows[0]!;
    const nameNode = within(firstRow).getByText("readme.md");
    const parentNode = within(firstRow).getByText("/projects/docs");
    expect(parentNode).toBeInTheDocument();
    expect(parentNode).not.toBe(nameNode);

    const secondRow = rows[1]!;
    expect(within(secondRow).getByText("/assets")).toBeInTheDocument();
  });

  it("each row renders its mime-family icon (a lucide <svg>)", () => {
    const store = makeStore();
    seedSearchResults(store);

    render(<SearchResults store={store} />);

    const rows = getResultRows();
    // Established project convention: lucide renders each icon as an <svg>
    // with a `lucide-<kebab-name>` class. See view-modes/__tests__/list.test.tsx
    // lines 261-267 for the pattern.
    const firstSvg = rows[0]!.querySelector("svg");
    expect(firstSvg).not.toBeNull();
    // readme.md has mimeFamily "text" → iconForEntry returns "file-text".
    expect(firstSvg!.getAttribute("class") ?? "").toMatch(
      /\blucide-file-text\b/,
    );

    const secondSvg = rows[1]!.querySelector("svg");
    expect(secondSvg).not.toBeNull();
    // hero.png has mimeFamily "image" → iconForEntry returns "file-image".
    expect(secondSvg!.getAttribute("class") ?? "").toMatch(
      /\blucide-file-image\b/,
    );
  });

  it("clicking a result calls onResultActivate exactly once with that result's FileEntry", () => {
    const store = makeStore();
    const [firstResult, secondResult] = seedSearchResults(store);
    const spy = vi.fn();

    render(<SearchResults store={store} onResultActivate={spy} />);

    const rows = getResultRows();
    fireEvent.click(rows[0]!);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(firstResult);

    fireEvent.click(rows[1]!);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(secondResult);
  });
});
