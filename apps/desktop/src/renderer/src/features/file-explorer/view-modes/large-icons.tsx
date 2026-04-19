"use client";

import { useSyncExternalStore } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { FileContextMenu } from "../context-menu.js";
import type { ExplorerStore } from "../store.js";
import { useSelection } from "../use-selection.js";
import { IconAboveNameCell } from "./icon-above-name-cell.js";

/**
 * LargeIconsView — per design.md Decision 3: 96 px icon above name,
 * wrapping grid. Shares the `IconAboveNameCell` shape with
 * MediumIconsView; here the icon renders at `size-24` (96 px) and
 * the grid track minimum widens to `10rem` so large cells breathe.
 */

export interface LargeIconsViewProps {
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

export function LargeIconsView({
  store,
  focusedId,
  setFocusedId,
  onOpen,
  onDownload,
  onRename,
  onDelete,
  onCopyPath,
  onProperties,
}: LargeIconsViewProps) {
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
      className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-4 p-3"
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
              iconSize="size-24"
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
