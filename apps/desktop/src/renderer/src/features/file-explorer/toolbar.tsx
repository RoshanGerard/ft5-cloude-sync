"use client";

import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { ExplorerStore, ViewMode } from "./store.js";

/**
 * Toolbar — the explorer chrome's action bar.
 *
 * Phase 3 ships the **View menu only**. Delete / Sort / Search /
 * Details-toggle controls arrive in Phase 4/5/6/7; adding them here later
 * is additive — a future commit composes additional sub-components into
 * the same `<div>` without reshaping this module's contract.
 *
 * The View menu pattern mirrors `features/theme/theme-switcher.tsx`: a
 * shadcn `DropdownMenu` whose current-value is bound to the store via
 * `useSyncExternalStore`. Using `DropdownMenuRadioGroup` +
 * `DropdownMenuRadioItem` is the canonical shadcn shape for a "pick one
 * of N, current marked" menu and gives us `role="menuitemradio"` +
 * `aria-checked` for free — the spec's "six radio-style items with the
 * currently-active mode marked as selected" is satisfied by Radix's
 * accessible markup, not by hand-rolled ARIA.
 *
 * Labels match `specs/file-explorer/spec.md` "Six view modes" scenario:
 * "List", "Details", "Small icons", "Tiles", "Medium icons", "Large
 * icons". The order in the menu matches the `OPTIONS` array below.
 */

export interface ToolbarProps {
  store: ExplorerStore;
}

interface ViewOption {
  value: ViewMode;
  label: string;
}

const OPTIONS: readonly ViewOption[] = [
  { value: "list", label: "List" },
  { value: "details", label: "Details" },
  { value: "small", label: "Small icons" },
  { value: "tiles", label: "Tiles" },
  { value: "medium", label: "Medium icons" },
  { value: "large", label: "Large icons" },
];

const VIEW_MODE_VALUES: readonly ViewMode[] = OPTIONS.map((o) => o.value);

function isViewMode(value: string): value is ViewMode {
  return (VIEW_MODE_VALUES as readonly string[]).includes(value);
}

export function Toolbar({ store }: ToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Explorer toolbar"
      className="flex items-center gap-1"
    >
      <ViewMenu store={store} />
      {/* Delete / Sort / Search / Details-toggle controls are Phase 4/5/6/7.
          They compose into this toolbar in a later change; intentionally
          left out here so Phase 3 ships only what its scope demands. */}
    </div>
  );
}

interface ViewMenuProps {
  store: ExplorerStore;
}

function ViewMenu({ store }: ViewMenuProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="View"
          data-testid="file-explorer-view-trigger"
        >
          View
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={state.viewMode}
          onValueChange={(value) => {
            if (isViewMode(value)) store.setViewMode(value);
          }}
        >
          {OPTIONS.map((opt) => (
            <DropdownMenuRadioItem key={opt.value} value={opt.value}>
              {opt.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
