"use client";

import { useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

import { iconForEntry } from "../icons.js";
import type { ExplorerStore } from "../store.js";
import { useSelection } from "../use-selection.js";

/**
 * SmallIconsView — the densest of the icon-oriented view modes
 * (design.md Decision 3). A wrapping flex flow of cells; each cell is
 * a 16-px icon sitting next to the entry's name. No type / size /
 * modified metadata — users pick Small Icons when they want to scan
 * many entries in a small area.
 *
 * Shared behaviour with DetailsView:
 *   - `useSelection` translates click events into selection actions.
 *   - Selected cells paint `bg-accent`.
 *   - Pending-op cells paint at `opacity-60` with the inline
 *     `animate-sync-pulse` glyph (design.md Decision 7).
 *   - Empty directories render the same "This folder is empty" line.
 *
 * The name truncates at `max-w-[10rem]` with a `title` attribute so
 * users can hover to see the full name.
 */

export interface SmallIconsViewProps {
  store: ExplorerStore;
}

export function SmallIconsView({ store }: SmallIconsViewProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const { selection, onEntryClick } = useSelection(store);

  if (state.entries.length === 0) {
    return (
      <div
        role="list"
        aria-label="Files"
        className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-8 text-xs"
      >
        <span>This folder is empty</span>
      </div>
    );
  }

  return (
    <div
      role="list"
      aria-label="Files"
      className="flex min-h-0 flex-1 flex-wrap content-start gap-2 p-2"
    >
      {state.entries.map((entry) => {
        const isSelected = selection.has(entry.id);
        const pendingOp = state.pendingOps[entry.id];
        return (
          <Cell
            key={entry.id}
            entry={entry}
            selected={isSelected}
            pending={pendingOp !== undefined}
            onClick={(e) => onEntryClick(entry.id, e)}
          />
        );
      })}
    </div>
  );
}

interface CellProps {
  entry: FileEntry;
  selected: boolean;
  pending: boolean;
  onClick: (event: ReactMouseEvent) => void;
}

function Cell({ entry, selected, pending, onClick }: CellProps) {
  const iconName = iconForEntry(entry);
  return (
    <div
      role="listitem"
      data-testid="explorer-cell"
      data-entry-id={entry.id}
      tabIndex={0}
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex cursor-default items-center gap-1 rounded-md px-1.5 py-1",
        "hover:bg-accent/50",
        selected && "bg-accent",
        pending && "opacity-60",
      )}
    >
      <Icon
        name={iconName}
        aria-hidden
        className="text-muted-foreground size-4 shrink-0"
      />
      <span
        className="max-w-[10rem] truncate text-sm"
        title={entry.name}
      >
        {entry.name}
      </span>
      {pending ? (
        <span
          data-testid="explorer-pending-glyph"
          aria-label="Operation in progress"
          className="bg-muted-foreground inline-block size-1.5 shrink-0 animate-sync-pulse"
        />
      ) : null}
    </div>
  );
}
