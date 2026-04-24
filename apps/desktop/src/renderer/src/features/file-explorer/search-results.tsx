"use client";

//
// SearchResults — Phase 7.4 implementation.
//
// Mounted in place of `<ViewModeSwitcher>` whenever
// `state.search.active === true` (composite swap plumbing lives in
// file-explorer.tsx). Surfaces each hit returned by
// `window.api.files.search` as a clickable row with:
//
//   - the mime-family icon from `iconForEntry(entry)` (routed through the
//     `Icon` adapter so the lucide dependency stays walled off)
//   - the entry's `name` on the primary line
//   - the entry's `parentPath` on a muted secondary line
//
// Clicking a row fires `onResultActivate(entry)`. The composite wires that
// to `store.clearSearch()` + `store.navigate(entry.parentPath)` + a pending
// focus-id the Phase 4 `useKeyboardNav` hook picks up once entries for the
// new path load.
//
// The two test-ids stabilised in the 7.2 stub stay stable:
//   - `data-testid="file-explorer-search-results"` — root surface
//   - `data-testid="file-explorer-search-clear"`   — Clear-search button
// Phase 7.3 adds a per-row id:
//   - `data-testid="file-explorer-search-result"`  — one per result row
//

import { useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

import { iconForEntry } from "./icons";
import type { ExplorerStore } from "./store";

/**
 * Abstract provider-kind discriminator used for presentation-layer
 * decisions (copy, deferred-state surfacing). Decoupled from the IPC
 * `ProviderId` so the UI can collapse `"amazon-s3"` into `"s3"` for
 * display purposes and future providers can be added without touching
 * the contract package.
 */
/**
 * Provider kind surfaced to the file-explorer feature. The three engine-
 * backed providers plus a `"mock"` sentinel for synthetic / in-memory
 * test datasources. Production callers never pass `"mock"`; it exists so
 * composite tests that mount `<FileExplorer>` against fake `window.api`
 * implementations can opt into the pre-engine behavior of every affordance
 * (e.g. Rename / Download stay enabled for mock datasources; see
 * wire-file-explorer-to-service spec § Rename and Download affordances
 * are disabled for engine-backed datasources).
 */
export type ProviderKind = "google-drive" | "onedrive" | "s3" | "mock";

/** True when the provider requires the engine for file operations. Used
 * to gate Rename / Download affordances in the toolbar and context menu
 * per wire-file-explorer-to-service Decision 5. */
export function isEngineBacked(kind: ProviderKind): boolean {
  return kind !== "mock";
}

const PROVIDER_HUMAN_NAME: Record<ProviderKind, string> = {
  "google-drive": "Google Drive",
  onedrive: "OneDrive",
  s3: "Amazon S3",
  mock: "Mock",
};

/**
 * Stable anchor for the deferred-work section of the file-explorer design
 * doc. The doc itself is produced in Phase 9.4 — this relative href works
 * in the Electron static-export runtime (the docs ship alongside the
 * renderer bundle) and degrades to a broken-link-with-visible-text in
 * jsdom, which is fine for the unit tests.
 */
const DEFERRED_DOCS_HREF = "./docs/design/file-explorer.md#deferred-work";

export interface SearchResultsProps {
  store: ExplorerStore;
  /**
   * Presentation-layer provider discriminator for the current datasource.
   * Drives the deferred-state copy + the "no results" vs deferred-surface
   * branch. The composite derives this from the datasource registry and
   * always passes a concrete value.
   */
  providerKind: ProviderKind;
  /**
   * Fires when the user activates a result (click or Enter/Space). The
   * composite consumes this to clear the search and navigate to the
   * entry's parent folder, then focuses the entry row once its folder's
   * entries have loaded.
   */
  onResultActivate?: (entry: FileEntry) => void;
}

export function SearchResults({
  store,
  providerKind,
  onResultActivate,
}: SearchResultsProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const results = state.search.results ?? [];
  const deferred = state.search.providerSearchDeferred === true;
  const providerName = PROVIDER_HUMAN_NAME[providerKind];

  return (
    <div
      data-testid="file-explorer-search-results"
      role="list"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-border flex items-center justify-between border-b px-3 py-2">
        <div className="text-muted-foreground text-sm">
          {deferred
            ? `Search unavailable for ${providerName}`
            : results.length === 0
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
      {deferred ? (
        <div
          data-testid="file-explorer-search-deferred"
          role="status"
          className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-6 text-sm"
        >
          <p className="text-foreground font-medium">
            {`Native search for ${providerName} is not available yet`}
          </p>
          <p className="text-muted-foreground">
            We&apos;re planning this as part of the provider-search follow-up.
            In the meantime, browse folders directly or try a different
            datasource.
          </p>
          <p>
            <a
              href={DEFERRED_DOCS_HREF}
              className="text-foreground underline"
            >
              See deferred-work docs
            </a>
          </p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto">
          {results.map((entry) => (
            <SearchResultRow
              key={entry.id}
              entry={entry}
              onActivate={onResultActivate}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface SearchResultRowProps {
  entry: FileEntry;
  onActivate?: (entry: FileEntry) => void;
}

function SearchResultRow({ entry, onActivate }: SearchResultRowProps) {
  const iconName = iconForEntry(entry);
  const handleActivate = (): void => {
    onActivate?.(entry);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>): void => {
    // The row is a button in disguise (role="button") so keyboard
    // activation via Enter/Space must mirror click semantics. A11y
    // guideline AA-compliant: no new surface is unreachable by keyboard.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate?.(entry);
    }
  };
  return (
    <li
      data-testid="file-explorer-search-result"
      data-entry-id={entry.id}
      role="button"
      tabIndex={0}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      className={cn(
        "border-border/50 flex cursor-default items-center gap-2 border-b px-3 py-1.5 text-sm outline-none",
        "hover:bg-accent/50",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset",
      )}
    >
      <div className="flex w-8 shrink-0 items-center justify-center">
        <Icon
          name={iconName}
          aria-hidden
          className="text-muted-foreground size-4"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{entry.name}</span>
        <span className="text-muted-foreground truncate text-xs">
          {entry.parentPath}
        </span>
      </div>
    </li>
  );
}
