"use client";

import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";

import type { ExplorerState, ExplorerStore } from "./store";

/**
 * StatusRow — bottom-pinned aria-live status strip for the explorer chrome.
 *
 * Renders one of three shapes depending on store state:
 *
 *   1. Idle (no active search): `N items` (plus ` · M selected` when the
 *      selection is non-empty). Matches design.md Decision 9's
 *      `N items · M selected` format.
 *   2. Search active with normal results: `Showing N results for "<query>"`.
 *      Appends ` · truncated` when the provider reports the scan hit its
 *      ceiling. Design.md Decision 9 phrases this as
 *      `Showing results for "query" · truncated`; we ship the numeric-count
 *      variant because the spec scenario for S3 also expects the count to
 *      be visible near the results ("Showing first N results"), and the
 *      status row is the single honest surface for that information.
 *   3. Search active with `providerSearchDeferred` (Google Drive / OneDrive
 *      in v1): surfaces a "not yet wired" message pointing at the
 *      deferred-work docs. The store's `providerSearchDeferred` flag is set
 *      by the search dispatcher when the `files:search` envelope returns
 *      `{ ok: false, error: { tag: "other", message: "provider native
 *      search is not wired yet; try a narrower path scope" } }` — it's a
 *      derived UI flag, not a wire-format field.
 *
 * Root element carries `role="status"` + `aria-live="polite"` so screen
 * readers announce changes without interrupting. Numeric segments wrap in
 * `tabular-nums` spans so digit widths stay stable when the count changes —
 * mirrors the Details-mode size/modified convention. `deriveStatusText`
 * is exported so the shape-decision logic is testable in isolation.
 */

export interface StatusRowProps {
  store: ExplorerStore;
}

export function StatusRow({ store }: StatusRowProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-border bg-background text-muted-foreground border-t px-3 py-1.5 text-xs"
    >
      {deriveStatusText(state)}
    </div>
  );
}

export function deriveStatusText(state: ExplorerState): ReactNode {
  const { search, entries, selection } = state;

  // --- Search active branches -------------------------------------------
  if (search.active && search.results !== null) {
    if (search.providerSearchDeferred) {
      // Drive / OneDrive v1: no real search yet. Keep the message honest
      // and point at the deferred-work docs. Wording intentionally avoids
      // naming a specific provider so the same row works for both.
      return (
        <>Search for this datasource is not yet wired — see the deferred-work docs</>
      );
    }

    const count = search.results.length;
    return (
      <>
        Showing <span className="tabular-nums">{count}</span> results for{" "}
        {`"${search.query}"`}
        {search.truncated ? (
          <>
            {" · "}
            truncated
          </>
        ) : null}
      </>
    );
  }

  // --- Idle branch -------------------------------------------------------
  const itemCount = entries.length;
  const selectedCount = selection.size;

  if (selectedCount === 0) {
    return (
      <>
        <span className="tabular-nums">{itemCount}</span> items
      </>
    );
  }

  return (
    <>
      <span className="tabular-nums">{itemCount}</span> items
      {" · "}
      <span className="tabular-nums">{selectedCount}</span> selected
    </>
  );
}
