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
  //
  // Three-state pagination count (add-engine-listdirectory-pagination
  // Visual direction V-3). The leading count + suffix is chosen by, in
  // precedence order:
  //   1. `loadMoreError !== null` (most recent load-more failed) →
  //      `N items · couldn't load more`. Wins over more-available because a
  //      failed `loadMore` leaves BOTH `loadMoreError` AND `nextCursor` set
  //      (the cursor is retained for the manual Retry) — see the store's
  //      `runPage`. The spec scenario "Status row indicates load-failed
  //      after exhausted retry" requires the failed copy here.
  //   2. `nextCursor !== null` (more pages available) →
  //      `N+ items · N loaded`.
  //   3. otherwise (everything loaded) → `N items` (existing no-suffix
  //      behavior).
  // The `· M selected` suffix is appended AFTER the pagination suffix in
  // every state when a selection exists.
  const itemCount = entries.length;
  const selectedCount = selection.size;
  const { loadMoreError, nextCursor, errorTag } = state;

  // The pagination suffix is suppressed whenever a tagged error owns the
  // main pane (`errorTag !== null` → a full-replace state component renders
  // in place of the entries). `nextCursor` / `loadMoreError` survive a
  // `retryLoad()`, so a refetch that fails (e.g. disconnected) can leave
  // them set while entries linger — without this guard the row would claim
  // "N+ items · N loaded" beneath a DisconnectedState. The region affordance
  // is gated the same way in `file-explorer.tsx`; this keeps the two
  // surfaces consistent. V-3 only governs the entries-showing states.
  const paginationSuffix: "more-available" | "load-failed" | "none" =
    errorTag !== null
      ? "none"
      : loadMoreError !== null
        ? "load-failed"
        : nextCursor !== null
          ? "more-available"
          : "none";

  const countSegment: ReactNode =
    paginationSuffix === "more-available" ? (
      // More-available: `N+ items · N loaded`.
      <>
        <span className="tabular-nums">{itemCount}</span>+ items
        {" · "}
        <span className="tabular-nums">{itemCount}</span> loaded
      </>
    ) : paginationSuffix === "load-failed" ? (
      // Most-recent load-more failed (after fs-sync's 4-attempt auto-retry
      // exhausted): `N items · couldn't load more`.
      <>
        <span className="tabular-nums">{itemCount}</span> items
        {" · "}
        couldn&apos;t load more
      </>
    ) : (
      // Exhausted / single page: `N items`.
      <>
        <span className="tabular-nums">{itemCount}</span> items
      </>
    );

  if (selectedCount === 0) {
    return countSegment;
  }

  return (
    <>
      {countSegment}
      {" · "}
      <span className="tabular-nums">{selectedCount}</span> selected
    </>
  );
}
