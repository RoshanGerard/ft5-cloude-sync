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
import { entryError, entryPendingOp } from "../pending-op-state";
import { ErrorPin, PendingOpGlyph } from "../pending-op-visuals";
import type { ExplorerStore } from "../store";
import { useSelection } from "../use-selection";

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
  onOpen?: (entry: FileEntry) => void;
  onDownload?: (entry: FileEntry) => void;
  onRename?: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
  onCopyPath?: (entry: FileEntry) => void;
  onProperties?: (entry: FileEntry) => void;
}

export function ListView({
  store,
  focusedId,
  setFocusedId,
  onOpen,
  onDownload,
  onRename,
  onDelete,
  onCopyPath,
  onProperties,
}: ListViewProps) {
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
        const pendingOp = entryPendingOp(state, entry);
        const errorReason = entryError(state, entry);
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
            <ListRow
              store={store}
              entry={entry}
              selected={isSelected}
              pending={pendingOp !== null}
              pendingKind={pendingOp?.kind ?? null}
              errorReason={errorReason}
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

interface ListRowProps extends ComponentPropsWithoutRef<"div"> {
  store: ExplorerStore;
  entry: FileEntry;
  selected: boolean;
  pending: boolean;
  pendingKind: "rename" | "remove" | null;
  errorReason: string | null;
  focused: boolean;
  onClick: (event: ReactMouseEvent) => void;
  ref?: Ref<HTMLDivElement>;
}

function ListRow({
  store,
  entry,
  selected,
  pending,
  pendingKind,
  errorReason,
  focused,
  onClick,
  ref: externalRef,
  ...rest
}: ListRowProps) {
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
      tabIndex={focused ? 0 : -1}
      data-testid="explorer-list-row"
      data-entry-id={entry.id}
      data-entry-kind={entry.kind}
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
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5",
          pendingKind === "remove" && "line-through",
        )}
      >
        <EntryNameCell store={store} entry={entry} />
        {pending ? <PendingOpGlyph /> : null}
        {errorReason !== null ? <ErrorPin reason={errorReason} /> : null}
      </span>
    </div>
  );
}
