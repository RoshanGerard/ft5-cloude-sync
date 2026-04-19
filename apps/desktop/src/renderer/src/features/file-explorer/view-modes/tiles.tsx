"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

import { iconForEntry } from "../icons.js";
import type { ExplorerStore } from "../store.js";
import { useSelection } from "../use-selection.js";
import { formatSize, formatType } from "./details-format.js";

/**
 * TilesView — wrapping grid of cards (design.md Decision 3). Each tile
 * has a 64-px icon on the left and, to its right, a column with:
 *   - the entry name (truncated, medium weight)
 *   - the type label ("Image", "Document", "Folder", …)
 *   - the formatted size ("12 KB", or "\u2014" for directories)
 *
 * Type reuses `formatType` from `details-format.ts` so the capitalized
 * `mimeFamily` rule stays in one place. Size reuses `formatSize` and
 * paints the line with `tabular-nums` so digit widths stay stable when
 * tiles wrap into a new column count.
 *
 * Shared behaviour with DetailsView: `useSelection` for click-mode
 * translation, `bg-accent` on selected, `opacity-60` + pulse glyph on
 * pending-op, the same "This folder is empty" empty-state text.
 */

export interface TilesViewProps {
  store: ExplorerStore;
  focusedId?: string | null;
  setFocusedId?: (id: string | null) => void;
}

export function TilesView({
  store,
  focusedId,
  setFocusedId,
}: TilesViewProps) {
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
        <span role="gridcell">This folder is empty</span>
      </div>
    );
  }

  return (
    <div
      role="grid"
      aria-label="Files"
      className="grid min-h-0 flex-1 content-start grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3 p-3"
    >
      {state.entries.map((entry) => {
        const isSelected = selection.has(entry.id);
        const pendingOp = state.pendingOps[entry.id];
        const isFocused = focusedId === entry.id;
        return (
          <Tile
            key={entry.id}
            entry={entry}
            selected={isSelected}
            pending={pendingOp !== undefined}
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

interface TileProps {
  entry: FileEntry;
  selected: boolean;
  pending: boolean;
  focused: boolean;
  onClick: (event: ReactMouseEvent) => void;
}

function Tile({
  entry,
  selected,
  pending,
  focused,
  onClick,
}: TileProps) {
  const iconName = iconForEntry(entry);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focused && ref.current !== null && document.activeElement !== ref.current) {
      ref.current.focus();
    }
  }, [focused]);
  return (
    <div
      ref={ref}
      role="gridcell"
      data-testid="explorer-tile"
      data-entry-id={entry.id}
      tabIndex={focused ? 0 : -1}
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "border-border flex cursor-default items-start gap-3 rounded-md border p-3 outline-none",
        "hover:bg-accent/50",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        selected && "bg-accent",
        pending && "opacity-60",
        focused && "ring-ring ring-2 ring-inset",
      )}
    >
      <Icon
        name={iconName}
        aria-hidden
        className="text-muted-foreground size-16 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span
            className="truncate text-sm font-medium"
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
        <span
          data-testid="explorer-tile-type"
          className="text-muted-foreground truncate text-xs"
        >
          {formatType(entry)}
        </span>
        <span
          data-testid="explorer-tile-size"
          className="text-muted-foreground truncate text-xs tabular-nums"
        >
          {formatSize(entry.size)}
        </span>
      </div>
    </div>
  );
}
