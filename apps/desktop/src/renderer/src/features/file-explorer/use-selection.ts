"use client";

import { useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { ExplorerStore } from "./store.js";

/**
 * `useSelection` — shared hook consumed by every view mode (Details now;
 * List / Small Icons / Tiles / Medium / Large as those land in later
 * tasks) to centralise the click-event → selection-mode translation.
 *
 * Semantics match the "Selection and keyboard navigation follow standard
 * conventions" requirement in the file-explorer spec:
 *   - plain click              → "replace"
 *   - shift + click            → "range" (inclusive, anchored on last
 *                                 selected)
 *   - ctrl / meta + click      → "toggle"
 *
 * Keyboard navigation (arrow keys, Enter, Delete, F2, Ctrl/Cmd+A) lands
 * in Phase 4's hook which will subsume this one. Scope here is click
 * events only.
 */
export interface UseSelectionResult {
  selection: Set<string>;
  onEntryClick: (entryId: string, event: ReactMouseEvent) => void;
}

export function useSelection(store: ExplorerStore): UseSelectionResult {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  function onEntryClick(entryId: string, event: ReactMouseEvent): void {
    const mode = event.shiftKey
      ? "range"
      : event.ctrlKey || event.metaKey
        ? "toggle"
        : "replace";
    store.select(entryId, mode);
  }

  return { selection: state.selection, onEntryClick };
}
