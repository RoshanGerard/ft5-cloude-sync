"use client";

import { useSyncExternalStore } from "react";

import type { ExplorerStore } from "../store.js";
import { useSelection } from "../use-selection.js";
import { IconAboveNameCell } from "./icon-above-name-cell.js";

/**
 * MediumIconsView — per design.md Decision 3: 64 px icon above name,
 * wrapping grid. Shares the `IconAboveNameCell` presentational shape
 * with LargeIconsView; this view mode renders the icon at `size-16`
 * (64 px) and sets the grid track minimum to `8rem`.
 *
 * Wiring matches DetailsView: subscribe via `useSyncExternalStore`,
 * dispatch clicks through `useSelection(store)`, paint the empty
 * state when there are no entries.
 */

export interface MediumIconsViewProps {
  store: ExplorerStore;
  focusedId?: string | null;
  setFocusedId?: (id: string | null) => void;
}

export function MediumIconsView({
  store,
  focusedId,
  setFocusedId,
}: MediumIconsViewProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const { selection, onEntryClick } = useSelection(store);

  if (state.entries.length === 0) {
    return (
      <div
        role="grid"
        aria-label="Files"
        className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-8 text-xs"
      >
        <span>This folder is empty</span>
      </div>
    );
  }

  return (
    <div
      role="grid"
      aria-label="Files"
      className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3 p-3"
    >
      {state.entries.map((entry) => {
        const isSelected = selection.has(entry.id);
        const pending = state.pendingOps[entry.id] !== undefined;
        const isFocused = focusedId === entry.id;
        return (
          <IconAboveNameCell
            key={entry.id}
            entry={entry}
            iconSize="size-16"
            selected={isSelected}
            pending={pending}
            focused={isFocused}
            onClick={(e) => {
              onEntryClick(entry.id, e);
              setFocusedId?.(entry.id);
            }}
          />
        );
      })}
    </div>
  );
}
