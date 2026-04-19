"use client";

import { useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { Icon, type IconName } from "@/components/icon";
import { cn } from "@/lib/utils";

import { iconForEntry } from "../icons.js";
import type { ExplorerStore, SortBy, SortDir } from "../store.js";
import { useSelection } from "../use-selection.js";
import { formatDate, formatSize, formatType } from "./details-format.js";

/**
 * DetailsView — default file-explorer view mode (design.md Decision 3).
 *
 * Five-column ARIA grid:
 *   icon | name | type | size | modified
 *
 * - Column headers (except icon) are focusable `<button>` elements that
 *   dispatch `store.setSort(column)`. The active column renders a small
 *   chevron-up / chevron-down Icon next to its label.
 * - Rows are clickable surfaces that dispatch the shared selection
 *   reducer via `useSelection`. Selected rows paint `bg-accent`.
 * - Rows with a pending op (`store.pendingOps[entry.id]` set) paint at
 *   `opacity-60` with an inline `animate-sync-pulse` glyph — per
 *   design.md Decision 7. The ACTIONS that populate pendingOps (rename
 *   / remove) land in Phase 6; the rendering concern lives here so
 *   every view mode honours it.
 * - Empty directories render a subtle centered "This folder is empty"
 *   line inside the grid surface.
 *
 * Keyboard navigation (arrow keys, Enter, Delete, F2, Ctrl/Cmd+A) is
 * deferred to Phase 4. Right-click context menu is also Phase 4.
 */

export interface DetailsViewProps {
  store: ExplorerStore;
}

interface ColumnDef {
  id: SortBy;
  label: string;
  className: string;
}

const COLUMNS: readonly ColumnDef[] = [
  { id: "name", label: "Name", className: "flex-1 min-w-0" },
  { id: "type", label: "Type", className: "w-28 shrink-0" },
  { id: "size", label: "Size", className: "w-24 shrink-0 text-right" },
  { id: "modified", label: "Modified", className: "w-32 shrink-0" },
];

const ICON_COLUMN_CLASS = "w-8 shrink-0 flex items-center justify-center";

export function DetailsView({ store }: DetailsViewProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const { selection, onEntryClick } = useSelection(store);

  return (
    <div
      role="grid"
      aria-label="Files"
      className="flex min-h-0 flex-1 flex-col text-sm"
    >
      <HeaderRow
        sortBy={state.sortBy}
        sortDir={state.sortDir}
        onSort={(by) => store.setSort(by)}
      />
      {state.entries.length === 0 ? (
        <div
          role="row"
          className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-xs"
        >
          <span role="cell">This folder is empty</span>
        </div>
      ) : (
        <div className="flex flex-col">
          {state.entries.map((entry) => {
            const isSelected = selection.has(entry.id);
            const pendingOp = state.pendingOps[entry.id];
            return (
              <DataRow
                key={entry.id}
                entry={entry}
                selected={isSelected}
                pending={pendingOp !== undefined}
                onClick={(e) => onEntryClick(entry.id, e)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface HeaderRowProps {
  sortBy: SortBy;
  sortDir: SortDir;
  onSort: (by: SortBy) => void;
}

function HeaderRow({ sortBy, sortDir, onSort }: HeaderRowProps) {
  return (
    <div
      role="row"
      className="border-border text-muted-foreground flex items-center gap-2 border-b px-2 py-1.5 text-xs font-medium"
    >
      {/* Icon column header — visually empty but still announced as a
          column so the column count matches the data rows. `aria-label`
          carries a minimal name so assistive tech has something to
          refer to; `getAllByRole('columnheader')` picks it up. */}
      <div
        role="columnheader"
        aria-label="Icon"
        className={ICON_COLUMN_CLASS}
      />
      {COLUMNS.map((col) => {
        const isActive = sortBy === col.id;
        const arrow: IconName = sortDir === "asc" ? "chevron-up" : "chevron-down";
        return (
          <div
            key={col.id}
            role="columnheader"
            aria-sort={
              isActive ? (sortDir === "asc" ? "ascending" : "descending") : "none"
            }
            className={col.className}
          >
            <button
              type="button"
              onClick={() => onSort(col.id)}
              className="hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-md px-1 outline-none transition-colors focus-visible:ring-[3px]"
            >
              <span>{col.label}</span>
              {isActive ? (
                <Icon
                  name={arrow}
                  aria-hidden
                  className="size-3"
                />
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}

interface DataRowProps {
  entry: FileEntry;
  selected: boolean;
  pending: boolean;
  onClick: (event: ReactMouseEvent) => void;
}

function DataRow({ entry, selected, pending, onClick }: DataRowProps) {
  const iconName = iconForEntry(entry);
  return (
    <div
      role="row"
      data-testid="explorer-row"
      data-entry-id={entry.id}
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "border-border/50 flex cursor-default items-center gap-2 border-b px-2 py-1.5",
        "hover:bg-accent/50",
        selected && "bg-accent",
        pending && "opacity-60",
      )}
    >
      <div role="cell" className={ICON_COLUMN_CLASS}>
        <Icon
          name={iconName}
          aria-hidden
          className="text-muted-foreground size-4"
        />
      </div>
      <div
        role="cell"
        data-testid="explorer-cell-name"
        className={cn("flex-1 min-w-0 flex items-center gap-1.5 truncate")}
      >
        <span className="truncate">{entry.name}</span>
        {pending ? (
          <span
            data-testid="explorer-pending-glyph"
            aria-label="Operation in progress"
            className="bg-muted-foreground inline-block size-1.5 shrink-0 animate-sync-pulse"
          />
        ) : null}
      </div>
      <div
        role="cell"
        data-testid="explorer-cell-type"
        className="text-muted-foreground w-28 shrink-0 truncate"
      >
        {formatType(entry)}
      </div>
      <div
        role="cell"
        data-testid="explorer-cell-size"
        className="text-muted-foreground w-24 shrink-0 text-right tabular-nums"
      >
        {formatSize(entry.size)}
      </div>
      <div
        role="cell"
        data-testid="explorer-cell-modified"
        className="text-muted-foreground w-32 shrink-0 tabular-nums"
      >
        {formatDate(entry.modifiedAt)}
      </div>
    </div>
  );
}
