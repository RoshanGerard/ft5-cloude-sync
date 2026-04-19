"use client";

import { useSyncExternalStore } from "react";

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
 * The design.md Decision 3 mode-table defines six concrete modes; each has
 * its own cell renderer. This switcher is a thin dispatch — no shared
 * state of its own. Selection, sort, and pending-op state all live in the
 * store, so switching modes is a pure renderer swap.
 *
 * The switch statement's exhaustive `never` tail doubles as a TS guard: if
 * a future `ViewMode` value is added to the union and this file is not
 * updated, the compiler refuses to build.
 */

export interface ViewModeSwitcherProps {
  store: ExplorerStore;
}

export function ViewModeSwitcher({ store }: ViewModeSwitcherProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  return renderForMode(state.viewMode, store);
}

function renderForMode(mode: ViewMode, store: ExplorerStore) {
  switch (mode) {
    case "list":
      return <ListView store={store} />;
    case "details":
      return <DetailsView store={store} />;
    case "small":
      return <SmallIconsView store={store} />;
    case "tiles":
      return <TilesView store={store} />;
    case "medium":
      return <MediumIconsView store={store} />;
    case "large":
      return <LargeIconsView store={store} />;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}
