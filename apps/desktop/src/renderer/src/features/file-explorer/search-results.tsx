"use client";

//
// SearchResults — Phase 7.2 stub.
//
// This is **swap plumbing only**: it satisfies the Phase 7.1 test contract
// (a surface with `data-testid="file-explorer-search-results"` mounted in
// place of `<ViewModeSwitcher>` while `state.search.active === true`, plus
// the `Clear search` affordance). Task 7.4 will replace the body with the
// real presentation — icons + parent-path secondary line + click-navigate.
//
// Keep the prop shape and the two stable test-ids
// (`file-explorer-search-results`, `file-explorer-search-clear`) as 7.4
// expands this file — the toolbar/composite swap wiring depends on them.
//

import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";

import type { ExplorerStore } from "./store";

export interface SearchResultsProps {
  store: ExplorerStore;
}

export function SearchResults({ store }: SearchResultsProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const results = state.search.results ?? [];

  return (
    <div
      data-testid="file-explorer-search-results"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-border flex items-center justify-between border-b px-3 py-2">
        <div className="text-muted-foreground text-sm">
          {results.length === 0
            ? "No results"
            : `${results.length} result${results.length === 1 ? "" : "s"}`}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Clear search"
          data-testid="file-explorer-search-clear"
          onClick={() => store.clearSearch()}
        >
          Clear search
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto">
        {results.map((entry) => (
          <li key={entry.id} className="px-3 py-1 text-sm">
            {entry.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
