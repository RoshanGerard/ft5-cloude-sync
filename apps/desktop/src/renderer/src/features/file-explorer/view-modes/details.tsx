"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
  ComponentPropsWithoutRef,
  MouseEvent as ReactMouseEvent,
  Ref,
} from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { Icon, type IconName } from "@/components/icon";
import { cn } from "@/lib/utils";

import { FileContextMenu } from "../context-menu";
import { iconForEntry } from "../icons";
import type { ExplorerStore, SortBy, SortDir } from "../store";
import { useSelection } from "../use-selection";
import { formatDate, formatSize, formatType } from "./details-format";

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
  /**
   * Phase 4 keyboard-nav wiring. All three props are optional so the
   * view mode still renders standalone (existing view-mode tests mount
   * it without the hook); when the composite explorer provides them,
   * the view mode paints the focus ring, updates `tabIndex`, and
   * syncs focus on click.
   */
  focusedId?: string | null;
  setFocusedId?: (id: string | null) => void;
  /**
   * Optional context-menu handlers forwarded to `FileContextMenu` on
   * each data row. Only the composite explorer supplies real
   * callbacks; view-mode tests mount without them and the wrapped
   * trigger stays silent for the menu items (Radix's disabled/no-op
   * handlers render fine).
   */
  onOpen?: (entry: FileEntry) => void;
  onDownload?: (entry: FileEntry) => void;
  onRename?: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
  onCopyPath?: (entry: FileEntry) => void;
  onProperties?: (entry: FileEntry) => void;
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

export function DetailsView({
  store,
  focusedId,
  setFocusedId,
  onOpen,
  onDownload,
  onRename,
  onDelete,
  onCopyPath,
  onProperties,
}: DetailsViewProps) {
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
                <DataRow
                  entry={entry}
                  selected={isSelected}
                  pending={pendingOp !== undefined}
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

interface DataRowProps extends ComponentPropsWithoutRef<"div"> {
  entry: FileEntry;
  selected: boolean;
  pending: boolean;
  focused: boolean;
  onClick: (event: ReactMouseEvent) => void;
  // React 19's ref-as-prop. Radix's ContextMenuTrigger (asChild) passes
  // a ref we need to merge with our internal roving-focus ref.
  ref?: Ref<HTMLDivElement>;
}

function DataRow({
  entry,
  selected,
  pending,
  focused,
  onClick,
  ref: externalRef,
  ...rest
}: DataRowProps) {
  const iconName = iconForEntry(entry);
  const ref = useRef<HTMLDivElement | null>(null);
  // Roving-tabindex: only the focused row is tab-reachable. On focus
  // change, also call `element.focus()` so browser focus tracks the
  // hook's `focusedId`. `:focus-visible` handles the ring; the ring
  // utilities below paint a constant highlight during programmatic
  // focus so keyboard navigation is visible without requiring the
  // `:focus-visible` pseudo-class.
  useEffect(() => {
    if (focused && ref.current !== null && document.activeElement !== ref.current) {
      ref.current.focus();
    }
  }, [focused]);
  // Merged ref: our internal ref is used by the focus-on-focused effect;
  // the external ref (if provided by Radix's ContextMenuTrigger via
  // asChild) is assigned via a ref callback so both stay in sync.
  const setRef = (node: HTMLDivElement | null): void => {
    ref.current = node;
    if (typeof externalRef === "function") externalRef(node);
    else if (externalRef !== null && externalRef !== undefined) {
      (externalRef as { current: HTMLDivElement | null }).current = node;
    }
  };
  return (
    <div
      {...rest}
      ref={setRef}
      role="row"
      data-testid="explorer-row"
      data-entry-id={entry.id}
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      onClick={onClick}
      className={cn(
        "border-border/50 flex cursor-default items-center gap-2 border-b px-2 py-1.5 outline-none",
        "hover:bg-accent/50",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        selected && "bg-accent",
        pending && "opacity-60",
        focused && "ring-ring ring-2 ring-inset",
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
