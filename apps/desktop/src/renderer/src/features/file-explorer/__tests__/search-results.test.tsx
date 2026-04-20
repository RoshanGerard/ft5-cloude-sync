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

//
// Phase 7.7 — deferred-state UI (TDD red).
//
// Contract (from tasks.md 7.7 + specs/file-explorer/spec.md scenario
// "Search for Drive or OneDrive shows the deferred-work state"):
//
//   WHEN the user enters a search query against a Google Drive or OneDrive
//   datasource and submits
//   THEN the UI renders an empty result area with the message
//   "Native search for Google Drive is not available yet" (or
//   "for OneDrive"); the search input remains populated; the message
//   links to the follow-up-work docs
//
// Main result area (`SearchResults`) currently renders "No results"
// regardless of the `providerSearchDeferred` flag — these assertions
// must fail semantically (missing deferred-surface testid, missing
// provider-named copy, missing docs link) until 7.8 lands.
//
// `providerKind` prop: the cleanest DI vector. The composite will pass
// the current datasource's provider kind from its registry entry in 7.8.
// TypeScript will complain about the unknown prop until 7.8 lands the
// type; `@ts-expect-error` comments mark those lines so the RED state
// is semantic-only (not a parse failure that crashes the whole file).
//
function seedDeferredSearch(
  store: ExplorerStore,
  query: string,
): void {
  act(() => {
    store.startSearch();
    store.setSearchQuery(query);
    // Third arg `providerSearchDeferred=true` mirrors the handler's
    // deferred-state envelope (`{ entries: [], truncated: true,
    // providerSearchDeferred: true }`).
    store.setSearchResults([], true, true);
  });
}

function getDeferredSurface(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-testid="file-explorer-search-deferred"]',
  );
}

describe("SearchResults — deferred state (7.7)", () => {
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

  it("Google Drive: renders a deferred surface with provider-named copy and a docs link", () => {
    // Datasource id mirrors mock-fs.ts (seedDrivePersonal → "ds-gdrive-personal").
    const store = makeStore("ds-gdrive-personal");
    seedDeferredSearch(store, "budget");

    render(
      // @ts-expect-error 7.8 will add providerKind to SearchResultsProps
      <SearchResults store={store} providerKind="google-drive" />,
    );

    const deferred = getDeferredSurface();
    expect(deferred).not.toBeNull();

    // Provider-named copy — the full spec message must appear somewhere
    // inside the deferred surface.
    expect(
      within(deferred!).getByText(/Google Drive/i),
    ).toBeInTheDocument();
    expect(
      within(deferred!).getByText(
        /Native search for Google Drive is not available yet/i,
      ),
    ).toBeInTheDocument();

    // Docs link — don't hardcode the URL; assert a meaningful anchor
    // exists whose text / aria-label mentions docs or deferred work, and
    // whose href is non-empty.
    const anchors = within(deferred!).queryAllByRole("link");
    const docsLink = anchors.find((a) => {
      const label = `${a.textContent ?? ""} ${a.getAttribute("aria-label") ?? ""}`;
      return /docs|deferred work/i.test(label);
    });
    expect(docsLink).toBeDefined();
    expect(docsLink!.getAttribute("href")).toBeTruthy();
  });

  it("OneDrive: renders a deferred surface with provider-named copy and a docs link", () => {
    // Datasource id mirrors mock-fs.ts (seedOneDriveWork → "ds-onedrive-work").
    const store = makeStore("ds-onedrive-work");
    seedDeferredSearch(store, "invoices");

    render(
      // @ts-expect-error 7.8 will add providerKind to SearchResultsProps
      <SearchResults store={store} providerKind="onedrive" />,
    );

    const deferred = getDeferredSurface();
    expect(deferred).not.toBeNull();

    expect(
      within(deferred!).getByText(/OneDrive/i),
    ).toBeInTheDocument();
    expect(
      within(deferred!).getByText(
        /Native search for OneDrive is not available yet/i,
      ),
    ).toBeInTheDocument();

    const anchors = within(deferred!).queryAllByRole("link");
    const docsLink = anchors.find((a) => {
      const label = `${a.textContent ?? ""} ${a.getAttribute("aria-label") ?? ""}`;
      return /docs|deferred work/i.test(label);
    });
    expect(docsLink).toBeDefined();
    expect(docsLink!.getAttribute("href")).toBeTruthy();
  });

  it("is NOT rendered when providerSearchDeferred is false/absent (S3-like case)", () => {
    const store = makeStore("ds-s3-bucket");
    const results = [
      seedEntry({
        id: "r-plan",
        kind: "file",
        name: "plan.md",
        path: "/reports/plan.md",
        parentPath: "/reports",
        mimeFamily: "text",
        mimeType: "text/markdown",
      }),
    ];
    act(() => {
      store.startSearch();
      store.setSearchQuery("plan");
      // No third arg → providerSearchDeferred defaults to false/undefined.
      store.setSearchResults(results, false);
    });

    render(
      // @ts-expect-error 7.8 will add providerKind to SearchResultsProps
      <SearchResults store={store} providerKind="s3" />,
    );

    expect(getDeferredSurface()).toBeNull();
  });

  it("keeps the Clear-search button present and functional in the deferred state", () => {
    const store = makeStore("ds-gdrive-personal");
    seedDeferredSearch(store, "budget");

    render(
      // @ts-expect-error 7.8 will add providerKind to SearchResultsProps
      <SearchResults store={store} providerKind="google-drive" />,
    );

    // Deferred surface is present to start.
    expect(getDeferredSurface()).not.toBeNull();

    const clearBtn = document.querySelector<HTMLElement>(
      '[data-testid="file-explorer-search-clear"]',
    );
    expect(clearBtn).not.toBeNull();

    fireEvent.click(clearBtn!);

    // store.clearSearch() fired → search is no longer active and the
    // deferred surface has left the DOM.
    expect(store.getSnapshot().search.active).toBe(false);
    expect(getDeferredSurface()).toBeNull();
  });
});
