"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

import { iconForEntry } from "../icons.js";
import type { ExplorerStore } from "../store.js";
import { useSelection } from "../use-selection.js";

/**
 * ListView — compact single-column view mode (design.md Decision 3).
 *
 * A vertical flow of rows, each rendered as a small clickable surface
 * carrying only an icon and the entry name. NO type / size / modified
 * columns — that's Details' responsibility. Per design.md Decision 9
 * the base type size is `text-sm`.
 *
 * Semantically this is a list (not a grid): the root container is
 * `role="list"` and each row is `role="listitem"`. Rows are `tabIndex=0`
 * so Phase 4 can wire roving-focus arrow-key navigation without a second
 * pass through this file; no key handlers are attached here yet.
 *
 * Clicks flow through the shared `useSelection` hook, so modifier-key
 * semantics (plain / shift / ctrl+meta) match every other view mode.
 * Pending-op rendering (opacity-60 + inline pulse glyph) mirrors the
 * Details convention; the glyph stays inline — factoring it into a
 * shared component would widen the surface without removing duplication
 * across sibling view-modes that each inline their own variant anyway.
 *
 * Empty state: when `entries.length === 0`, render a subtle
 * "This folder is empty" message as a sibling of the (empty) list.
 * Wrapping the message in a `<li>` would be semantically wrong — it is
 * not an entry — so it lives outside the list container.
 */

export interface ListViewProps {
  store: ExplorerStore;
  focusedId?: string | null;
  setFocusedId?: (id: string | null) => void;
}

export function ListView({ store, focusedId, setFocusedId }: ListViewProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const { selection, onEntryClick } = useSelection(store);

  if (state.entries.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col text-sm">
        <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-xs">
          <span>This folder is empty</span>
        </div>
      </div>
    );
  }

  return (
    <div
      role="list"
      aria-label="Files"
      className="flex min-h-0 flex-1 flex-col text-sm"
    >
      {state.entries.map((entry) => {
        const isSelected = selection.has(entry.id);
        const pendingOp = state.pendingOps[entry.id];
        const isFocused = focusedId === entry.id;
        return (
          <ListRow
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

interface ListRowProps {
  entry: FileEntry;
  selected: boolean;
  pending: boolean;
  focused: boolean;
  onClick: (event: ReactMouseEvent) => void;
}

function ListRow({
  entry,
  selected,
  pending,
  focused,
  onClick,
}: ListRowProps) {
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
      role="listitem"
      tabIndex={focused ? 0 : -1}
      data-testid="explorer-list-row"
      data-entry-id={entry.id}
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "flex cursor-default items-center gap-2 px-2 py-1 outline-none",
        "hover:bg-accent/50",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        selected && "bg-accent text-accent-foreground",
        pending && "opacity-60",
        focused && "ring-ring ring-2 ring-inset",
      )}
    >
      <Icon
        name={iconName}
        aria-hidden
        className="text-muted-foreground size-4 shrink-0"
      />
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate">{entry.name}</span>
        {pending ? (
          <span
            data-testid="explorer-pending-glyph"
            aria-label="Operation in progress"
            className="bg-muted-foreground inline-block size-1.5 shrink-0 animate-sync-pulse"
          />
        ) : null}
      </span>
    </div>
  );
}
