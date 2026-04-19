"use client";

import { useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import type { ExplorerStore, ViewMode } from "./store.js";
import { DetailsView } from "./view-modes/details.js";
import { LargeIconsView } from "./view-modes/large-icons.js";
import { ListView } from "./view-modes/list.js";
import { MediumIconsView } from "./view-modes/medium-icons.js";
import { SmallIconsView } from "./view-modes/small-icons.js";
import { TilesView } from "./view-modes/tiles.js";

/**
 * ViewModeSwitcher — renders the active view-mode component by reading
 * `state.viewMode`. Kept separate from `toolbar.tsx` so the Phase 4 status
 * row and Phase 5 details pane can compose with it cleanly in the
 * composite explorer page (Phase 4+).
 *
 * The switch statement's exhaustive `never` tail doubles as a TS guard: if
 * a future `ViewMode` value is added to the union and this file is not
 * updated, the compiler refuses to build.
 *
 * ### Keyboard navigation composition (Phase 4.4)
 *
 * The switcher accepts an optional `keyboardNav` bag — the return value
 * of `useKeyboardNav(store, options)` — and:
 *   - Binds `onKeyDown` on the outermost container so arrow keys fire
 *     regardless of which cell currently holds browser focus.
 *   - Forwards `focusedId` + `setFocusedId` into each view-mode renderer
 *     so the six modes paint the focus ring and manage their roving
 *     tabindex consistently.
 *
 * When `keyboardNav` is omitted (view-mode tests that mount a single
 * view mode directly), each view-mode component falls back to the
 * non-keyboard shape it shipped with in Phase 3.
 *
 * ### Ownership note (for Subagent P / composite wiring)
 *
 * The `keyboardNav` bag MUST be instantiated by the composite above the
 * switcher (`useKeyboardNav(store, options)` called once per explorer
 * mount) and forwarded in, NOT instantiated inside the switcher. Owning
 * it here would re-create `focusedId` state on every view-mode switch
 * and break the "focus is on one of the selected entries (last-focused
 * in Details)" scenario from the spec. The switcher intentionally has
 * no `useKeyboardNav` call of its own.
 */

export interface ViewModeKeyboardNav {
  focusedId: string | null;
  setFocusedId: (id: string | null) => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
}

/**
 * Per-entry action handlers forwarded to whichever view mode is
 * currently active, which in turn forwards them to the per-cell
 * `FileContextMenu` trigger. Only the composite `FileExplorer` supplies
 * real callbacks; `mode-switch-integration.test.tsx` and every
 * view-mode-only test mounts without them — the menu still renders,
 * Radix just calls no-op `undefined` handlers.
 */
export interface ViewModeActionHandlers {
  onOpen?: (entry: FileEntry) => void;
  onDownload?: (entry: FileEntry) => void;
  onRename?: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
  onCopyPath?: (entry: FileEntry) => void;
  onProperties?: (entry: FileEntry) => void;
}

export interface ViewModeSwitcherProps extends ViewModeActionHandlers {
  store: ExplorerStore;
  keyboardNav?: ViewModeKeyboardNav;
}

export function ViewModeSwitcher({
  store,
  keyboardNav,
  onOpen,
  onDownload,
  onRename,
  onDelete,
  onCopyPath,
  onProperties,
}: ViewModeSwitcherProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  const actions: ViewModeActionHandlers = {
    onOpen,
    onDownload,
    onRename,
    onDelete,
    onCopyPath,
    onProperties,
  };

  const view = renderForMode(state.viewMode, store, keyboardNav, actions);

  if (keyboardNav === undefined) return view;

  // Roving-tabindex entry point: when no row is focused (first mount,
  // post-navigation) the container itself is tab-reachable so keyboard
  // users can land in the grid from the toolbar via Tab. The first
  // ArrowDown/ArrowUp/Home/End then seeds `focusedId`, at which point
  // the focused row takes over the tabindex=0 slot and the container
  // drops to -1. This mirrors the WAI-ARIA grid pattern.
  const containerTabIndex = keyboardNav.focusedId === null ? 0 : -1;

  return (
    <div
      data-testid="view-mode-keyboard-container"
      tabIndex={containerTabIndex}
      onKeyDown={keyboardNav.onKeyDown}
      className="flex min-h-0 flex-1 flex-col outline-none focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset"
    >
      {view}
    </div>
  );
}

function renderForMode(
  mode: ViewMode,
  store: ExplorerStore,
  kbd: ViewModeKeyboardNav | undefined,
  actions: ViewModeActionHandlers,
) {
  const focusedId = kbd?.focusedId ?? null;
  const setFocusedId = kbd?.setFocusedId;
  switch (mode) {
    case "list":
      return (
        <ListView
          store={store}
          focusedId={focusedId}
          setFocusedId={setFocusedId}
          {...actions}
        />
      );
    case "details":
      return (
        <DetailsView
          store={store}
          focusedId={focusedId}
          setFocusedId={setFocusedId}
          {...actions}
        />
      );
    case "small":
      return (
        <SmallIconsView
          store={store}
          focusedId={focusedId}
          setFocusedId={setFocusedId}
          {...actions}
        />
      );
    case "tiles":
      return (
        <TilesView
          store={store}
          focusedId={focusedId}
          setFocusedId={setFocusedId}
          {...actions}
        />
      );
    case "medium":
      return (
        <MediumIconsView
          store={store}
          focusedId={focusedId}
          setFocusedId={setFocusedId}
          {...actions}
        />
      );
    case "large":
      return (
        <LargeIconsView
          store={store}
          focusedId={focusedId}
          setFocusedId={setFocusedId}
          {...actions}
        />
      );
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}
