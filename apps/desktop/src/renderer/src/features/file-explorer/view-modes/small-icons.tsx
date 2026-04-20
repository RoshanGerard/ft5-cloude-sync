"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type {
  ComponentPropsWithoutRef,
  MouseEvent as ReactMouseEvent,
  Ref,
} from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

import { FileContextMenu } from "../context-menu";
import { EntryNameCell } from "../entry-name-cell";
import { iconForEntry } from "../icons";
import type { ExplorerStore } from "../store";
import { useSelection } from "../use-selection";

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
  focusedId?: string | null;
  setFocusedId?: (id: string | null) => void;
  onOpen?: (entry: FileEntry) => void;
  onDownload?: (entry: FileEntry) => void;
  onRename?: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
  onCopyPath?: (entry: FileEntry) => void;
  onProperties?: (entry: FileEntry) => void;
}

export function SmallIconsView({
  store,
  focusedId,
  setFocusedId,
  onOpen,
  onDownload,
  onRename,
  onDelete,
  onCopyPath,
  onProperties,
}: SmallIconsViewProps) {
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
            <Cell
              store={store}
              entry={entry}
              selected={isSelected}
              pending={pendingOp !== undefined}
              focused={isFocused}
              onClick={(e) => {
                onEntryClick(entry.id, e);
                setFocusedId?.(entry.id);
              }}
              onDoubleClick={() => onOpen?.(entry)}
            />
          </FileContextMenu>
        );
      })}
    </div>
  );
}

interface CellProps extends ComponentPropsWithoutRef<"div"> {
  store: ExplorerStore;
  entry: FileEntry;
  selected: boolean;
  pending: boolean;
  focused: boolean;
  onClick: (event: ReactMouseEvent) => void;
  ref?: Ref<HTMLDivElement>;
}

function Cell({
  store,
  entry,
  selected,
  pending,
  focused,
  onClick,
  ref: externalRef,
  ...rest
}: CellProps) {
  const iconName = iconForEntry(entry);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focused && ref.current !== null && document.activeElement !== ref.current) {
      ref.current.focus();
    }
  }, [focused]);
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
      role="listitem"
      data-testid="explorer-cell"
      data-entry-id={entry.id}
      tabIndex={focused ? 0 : -1}
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex cursor-default items-center gap-1 rounded-md px-1.5 py-1 outline-none",
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
        className="text-muted-foreground size-4 shrink-0"
      />
      <EntryNameCell
        store={store}
        entry={entry}
        className="max-w-[10rem] text-sm"
        titleAttr={entry.name}
      />
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
