"use client";

import { useSyncExternalStore } from "react";

import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";

import type { ExplorerStore } from "./store";

/**
 * LoadMoreRegion — the single shared "load-more region" for the file-explorer
 * (add-engine-listdirectory-pagination, Visual direction V-1 + V-2).
 *
 * Placement (owned by `file-explorer.tsx`, NOT by any view mode): a dedicated
 * region BETWEEN the scrollable entries area and the status row. It is never
 * inside a view-mode's `overflow-auto` scroll container, so it stays visible
 * at the bottom regardless of scroll position and renders identically below
 * all six view modes (List, Details, Small/Medium/Large Icons, Tiles) at full
 * width. The composite gates its mount on "entries are showing" so it never
 * appears under a search surface, skeleton, empty, or full-replace error
 * state — see `file-explorer.tsx`.
 *
 * Region state machine (precedence order — mirrors the status-row V-3
 * precedence so the two surfaces never disagree):
 *   (a) `loadMoreError !== null` → the V-2 page-load-failed retry row. Wins
 *       over (b) because a failed `loadMore` leaves BOTH `loadMoreError` AND
 *       `nextCursor` set (the cursor is retained for the manual Retry).
 *   (b) `nextCursor !== null`     → the V-1 ghost "Load more" button.
 *   (c) otherwise                 → renders nothing (listing exhausted).
 *
 * Busy handling: `loadMore` / `retryLoadMore` set `loadingMore` (NOT the
 * full-listing `loading`), and `runPage` clears `loadMoreError` at the start
 * of every attempt. So during a manual Retry the machine falls through from
 * (a) back to (b) with `loadingMore === true` — i.e. the busy ghost button —
 * which IS V-2's "swap back to the Load-more busy-state appearance". No
 * special retry-busy branch is needed.
 */

export interface LoadMoreRegionProps {
  store: ExplorerStore;
}

export function LoadMoreRegion({ store }: LoadMoreRegionProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  const { nextCursor, loadingMore, loadMoreError } = state;

  // (a) Failed row wins — but only when NOT mid-retry. `runPage` clears
  // `loadMoreError` before re-issuing, so `loadMoreError !== null` implies
  // we are at rest after an exhausted attempt; if a retry is in flight the
  // error is already null and we fall through to the busy button below.
  if (loadMoreError !== null) {
    return (
      <PageLoadFailedRow
        tag={loadMoreError.tag}
        message={loadMoreError.message}
        onRetry={() => {
          void store.retryLoadMore();
        }}
      />
    );
  }

  // (b) More pages available → ghost "Load more" button (busy or idle).
  if (nextCursor !== null) {
    return (
      <LoadMoreButton
        isBusy={loadingMore}
        onClick={() => {
          void store.loadMore();
        }}
      />
    );
  }

  // (c) Listing exhausted → nothing.
  return null;
}

/**
 * V-1 ghost "Load more" button. Locked component contract from design.md:
 * full-width shadcn `Button variant="ghost"`, `rounded-none border-t
 * border-border h-10 font-medium`, a leading `ChevronDown` glyph, and the
 * visible label "Load more". While busy it sets `aria-busy`, is `disabled`,
 * and the chevron is SWAPPED for a spinner (per spec scenario "Busy state
 * during in-flight load-more" — the chevron is replaced, not joined).
 */
function LoadMoreButton({
  isBusy,
  onClick,
}: {
  isBusy: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="w-full justify-center gap-2 rounded-none border-t border-border h-10 font-medium"
      aria-busy={isBusy}
      disabled={isBusy}
      onClick={onClick}
    >
      {isBusy ? (
        // Spinner reuses the registered `refresh-cw` glyph with `animate-spin`
        // (the adapter is the one place lucide is imported; there is no
        // standalone Spinner primitive — sonner's loading template uses the
        // same animate-spin idiom).
        <Icon
          name="refresh-cw"
          className="size-4 animate-spin"
          aria-hidden="true"
        />
      ) : (
        <Icon name="chevron-down" className="size-4" aria-hidden="true" />
      )}
      Load more
    </Button>
  );
}

/**
 * V-2 page-load-failed retry row. Swaps in-place for the Load-more button
 * when fs-sync's 4-attempt auto-retry has exhausted. Two-line layout at
 * ~`h-20`: `bg-destructive/8` tint, `border-t border-destructive/20`,
 * `text-destructive`; a leading `AlertCircle`, a bold "Couldn't load more
 * entries" headline, a smaller detail line (humanized tag + provider message
 * + the static "after 4 attempts" phrasing), and a full-width outline Retry
 * button below.
 *
 * Accessibility: the row announces via `aria-live="assertive"` (the failure
 * is consequential and worth interrupting), and it does NOT take focus on
 * appearance — no `autoFocus` — so the user's place in the entries area is
 * preserved. Already-loaded entries stay visible (the store never clears
 * `entries` on a page-load failure).
 */
function PageLoadFailedRow({
  tag,
  message,
  onRetry,
}: {
  tag: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid="load-more-failed"
      role="alert"
      aria-live="assertive"
      className="flex min-h-20 w-full flex-col gap-2 border-t border-destructive/20 bg-destructive/8 px-3 py-2.5 text-destructive"
    >
      <div className="flex items-start gap-2">
        <Icon
          name="alert-circle"
          className="mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">Couldn&apos;t load more entries</span>
          <span className="text-xs font-normal opacity-85">
            {humanizeFilesErrorTag(tag)}: {message} after 4 attempts
          </span>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        className="w-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

/**
 * Humanize a wire-level `FilesErrorTag` for the V-2 detail line. The
 * renderer-observable tag is always one of the WIRE tags (fs-sync's
 * `normalizeFilesError` maps engine tags to the wire `FilesErrorTag`
 * vocabulary — e.g. engine `network-error` → wire `disconnected`, generic
 * engine `provider-error` → wire `other`), so the known-tag map covers the
 * wire vocabulary. Any unmapped token title-cases gracefully as a defensive
 * fallback, so the row never shows a raw machine token.
 *
 * Exported for unit testing in isolation.
 */
export function humanizeFilesErrorTag(tag: string): string {
  const KNOWN: Record<string, string> = {
    "rate-limited": "Rate limited",
    "auth-revoked": "Authorization revoked",
    disconnected: "Disconnected",
    "invalid-datasource": "Invalid datasource",
    cancelled: "Cancelled",
    "exhausted-retries": "Couldn't reach the provider",
    conflict: "Conflict",
    // The generic wire fallback — show a plain "Error" prefix rather than
    // the bare token, since the message carries the specifics.
    other: "Error",
  };
  const known = KNOWN[tag];
  if (known !== undefined) return known;
  // Title-case a kebab/space token: "network-error" → "Network error".
  const spaced = tag.replace(/[-_]+/g, " ").trim();
  if (spaced.length === 0) return "Error";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
