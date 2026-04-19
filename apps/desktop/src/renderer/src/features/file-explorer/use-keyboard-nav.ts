"use client";

import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import type { ExplorerStore } from "./store";

/**
 * `useKeyboardNav` — the second store-prop hook (alongside `useSelection`)
 * consumed by every view mode. It owns the ephemeral focus-id state
 * (focus is not persisted anywhere — view-mode switches, re-renders, and
 * path navigation all reset it) and translates keyboard events into
 * store actions plus owner-supplied callbacks.
 *
 * Bindings follow the "Selection and keyboard navigation follow standard
 * conventions" requirement in `openspec/changes/ui-file-explorer/specs/
 * file-explorer/spec.md`:
 *
 *   - ArrowDown / ArrowUp — move focus within the visible, sort-resolved
 *     entries. Does NOT change selection unless Shift is held.
 *   - Shift+ArrowDown / Shift+ArrowUp — move focus AND extend the
 *     range selection via `store.select(id, "range")`.
 *   - Home / End — move focus to first / last visible entry.
 *   - Enter — call `onActivate(focusedEntry)`. The owner decides the
 *     effect; the file-explorer composite wires directories to
 *     `store.navigate(entry.path)` and files to a no-op in v1.
 *   - F2 — call `onRenameRequested(focusedEntry)` for file entries
 *     only; ignored for directory entries. Phase 6 wires this to
 *     inline rename UI.
 *   - Delete — call `onDeleteRequested(selectedEntries)` where
 *     `selectedEntries` is the current `store.selection` ∩ `entries`.
 *     Empty selection is a no-op. Phase 6 wires this to the
 *     confirm-delete dialog.
 *   - Ctrl+A / Cmd+A — `store.selectAll()`.
 *
 * Focus state lives on the hook rather than the store because focus is
 * ephemeral UI state — it's valid only as long as the current view is
 * mounted, resets when the user navigates to a new folder or switches
 * datasources, and does NOT persist across reloads. The store stays
 * narrow by keeping it out.
 *
 * View-mode components consume this hook indirectly through the
 * `ViewModeSwitcher`: the switcher owns the hook, forwards
 * `focusedId` / `setFocusedId` to each view mode, and binds `onKeyDown`
 * on the outermost container so arrow keys fire regardless of which
 * cell currently holds browser focus.
 */

export interface KeyboardNavOptions {
  entries: readonly FileEntry[];
  onActivate?: (entry: FileEntry) => void;
  onRenameRequested?: (entry: FileEntry) => void;
  onDeleteRequested?: (entries: FileEntry[]) => void;
  /**
   * Fires when the user presses Shift+F10 or the ContextMenu key on a
   * focused entry — the keyboard equivalent of a right click, per the
   * "Right-click context menu" requirement. The composite explorer
   * wires this to open `FileContextMenu` programmatically at the
   * focused entry. If no entry is focused, the key presses are a no-op.
   */
  onContextMenuRequested?: (entry: FileEntry) => void;
}

export interface UseKeyboardNavResult {
  focusedId: string | null;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  setFocusedId: (id: string | null) => void;
}

export function useKeyboardNav(
  store: ExplorerStore,
  options: KeyboardNavOptions,
): UseKeyboardNavResult {
  const {
    entries,
    onActivate,
    onRenameRequested,
    onDeleteRequested,
    onContextMenuRequested,
  } = options;
  const [focusedId, setFocusedIdState] = useState<string | null>(null);
  // Mirror focusedId in a ref so rapid synchronous onKeyDown calls see the
  // updated value without waiting for a re-render. Without this, two
  // sequential ArrowDown calls inside a single React batch both read the
  // stale closed-over `focusedId === null` and compute index 0 twice. In
  // real UI key events land on separate frames so the stale-closure
  // scenario is only a test concern; the ref still makes the hook honest
  // under any caller's dispatch pattern.
  const focusedIdRef = useRef<string | null>(null);
  const setFocusedId = useCallback((id: string | null) => {
    focusedIdRef.current = id;
    setFocusedIdState(id);
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // Ctrl/Cmd+A is selection-only and does not care about a current
      // focused entry. Handle it first so it fires even when focus has
      // not been primed yet.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        store.selectAll();
        return;
      }

      // Shift+F10 / ContextMenu key — the keyboard equivalent of right
      // click. These are handled before the `entries.length === 0`
      // guard only inasmuch as they rely on a focused entry, which
      // itself implies non-empty entries (focus can only be seeded from
      // within the list). Kept here (ahead of the switch) so they don't
      // tangle with the arrow-key case block below.
      if (
        (event.shiftKey && event.key === "F10") ||
        event.key === "ContextMenu"
      ) {
        const currentFocus = focusedIdRef.current;
        if (currentFocus === null) return;
        const entry = entries.find((e) => e.id === currentFocus);
        if (entry === undefined) return;
        event.preventDefault();
        onContextMenuRequested?.(entry);
        return;
      }

      if (entries.length === 0) return;

      const currentFocus = focusedIdRef.current;
      const currentIdx =
        currentFocus === null
          ? -1
          : entries.findIndex((e) => e.id === currentFocus);

      const focus = (idx: number): void => {
        const target = entries[idx];
        if (target === undefined) return;
        setFocusedId(target.id);
      };

      const extendTo = (idx: number): void => {
        const target = entries[idx];
        if (target === undefined) return;
        store.select(target.id, "range");
        setFocusedId(target.id);
      };

      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          const nextIdx =
            currentIdx < 0 ? 0 : Math.min(entries.length - 1, currentIdx + 1);
          if (event.shiftKey) extendTo(nextIdx);
          else focus(nextIdx);
          return;
        }
        case "ArrowUp": {
          event.preventDefault();
          const nextIdx =
            currentIdx < 0 ? 0 : Math.max(0, currentIdx - 1);
          if (event.shiftKey) extendTo(nextIdx);
          else focus(nextIdx);
          return;
        }
        case "Home": {
          event.preventDefault();
          focus(0);
          return;
        }
        case "End": {
          event.preventDefault();
          focus(entries.length - 1);
          return;
        }
        case "Enter": {
          if (currentIdx < 0) return;
          const entry = entries[currentIdx];
          if (entry === undefined) return;
          event.preventDefault();
          onActivate?.(entry);
          return;
        }
        case "F2": {
          if (currentIdx < 0) return;
          const entry = entries[currentIdx];
          if (entry === undefined) return;
          if (entry.kind !== "file") return; // directory rename disabled in v1
          event.preventDefault();
          onRenameRequested?.(entry);
          return;
        }
        case "Delete": {
          const selection = store.getSnapshot().selection;
          if (selection.size === 0) return;
          const selected = entries.filter((e) => selection.has(e.id));
          if (selected.length === 0) return;
          event.preventDefault();
          onDeleteRequested?.(selected);
          return;
        }
        default:
          return;
      }
    },
    [
      store,
      entries,
      setFocusedId,
      onActivate,
      onRenameRequested,
      onDeleteRequested,
      onContextMenuRequested,
    ],
  );

  return { focusedId, onKeyDown, setFocusedId };
}
