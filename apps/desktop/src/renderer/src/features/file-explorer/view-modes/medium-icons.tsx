"use client";

import { useSyncExternalStore } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { FileContextMenu } from "../context-menu";
import type { ExplorerStore } from "../store";
import { useSelection } from "../use-selection";
import { IconAboveNameCell } from "./icon-above-name-cell";

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
  onOpen?: (entry: FileEntry) => void;
  onDownload?: (entry: FileEntry) => void;
  onRename?: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
  onCopyPath?: (entry: FileEntry) => void;
  onProperties?: (entry: FileEntry) => void;
}

export function MediumIconsView({
  store,
  focusedId,
  setFocusedId,
  onOpen,
  onDownload,
  onRename,
  onDelete,
  onCopyPath,
  onProperties,
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
          <FileContextMenu
            key={entry.id}
            entry={entry}
            onOpen={onOpen}
            onDownload={onDownload}
            onRename={onRename}
            onDelete={onDelete}
            onCopyPath={onCopyPath}
            onProperties={onProperties}
          >
            <IconAboveNameCell
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
          </FileContextMenu>
        );
      })}
    </div>
  );
}
