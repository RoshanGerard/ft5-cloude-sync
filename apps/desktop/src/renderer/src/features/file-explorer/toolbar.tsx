"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import type { FilesSearchResponse } from "@ft5/ipc-contracts";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/icon";

import type { ExplorerStore, ViewMode } from "./store";

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
  // Fires when the Delete toolbar button is activated; composite wiring
  // opens the confirm-delete dialog with `store.selection` as the target.
  onDeleteSelection?: () => void;
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

export function Toolbar({ store, onDeleteSelection }: ToolbarProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return (
    <div
      role="toolbar"
      aria-label="Explorer toolbar"
      className="flex items-center gap-1"
    >
      {state.search.active ? (
        <SearchInput store={store} />
      ) : (
        <SearchButton store={store} />
      )}
      <DeleteButton store={store} onDelete={onDeleteSelection} />
      <ViewMenu store={store} />
      <DetailsToggle store={store} />
      {/* Sort control is a later phase. */}
    </div>
  );
}

interface SearchButtonProps {
  store: ExplorerStore;
}

function SearchButton({ store }: SearchButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="Search"
      data-testid="file-explorer-search-trigger"
      onClick={() => store.startSearch()}
    >
      <Icon name="search" aria-hidden="true" />
    </Button>
  );
}

interface SearchInputProps {
  store: ExplorerStore;
}

function SearchInput({ store }: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const dispatchSearch = async (query: string): Promise<void> => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    const api = (globalThis as unknown as {
      window?: {
        api?: {
          files?: {
            search?: (req: {
              datasourceId: string;
              query: string;
              path: string;
            }) => Promise<FilesSearchResponse>;
          };
        };
      };
    }).window?.api?.files?.search;
    if (api === undefined) return;
    const response = await api({
      datasourceId: store.datasourceId,
      query: trimmed,
      path: "/",
    });
    store.setSearchResults(
      response.entries,
      response.truncated,
      response.providerSearchDeferred,
    );
  };

  return (
    <input
      ref={inputRef}
      type="search"
      aria-label="Search"
      data-testid="file-explorer-search-input"
      placeholder="Search"
      className="border-border bg-background h-8 min-w-0 rounded-md border px-2 text-sm"
      onChange={(e) => store.setSearchQuery(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void dispatchSearch(e.currentTarget.value);
        }
      }}
    />
  );
}

interface DeleteButtonProps {
  store: ExplorerStore;
  onDelete?: () => void;
}

function DeleteButton({ store, onDelete }: DeleteButtonProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const disabled = state.selection.size === 0;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="Delete selection"
      disabled={disabled}
      data-testid="file-explorer-delete-trigger"
      onClick={() => onDelete?.()}
    >
      <Icon name="trash-2" aria-hidden="true" />
    </Button>
  );
}

interface DetailsToggleProps {
  store: ExplorerStore;
}

function DetailsToggle({ store }: DetailsToggleProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const open = state.detailsPaneOpen;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="Details"
      aria-pressed={open}
      data-testid="file-explorer-details-toggle"
      onClick={() => store.toggleDetailsPane()}
    >
      Details
    </Button>
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
