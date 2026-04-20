"use client";

import { useEffect, useRef } from "react";
import type {
  ComponentPropsWithoutRef,
  MouseEvent as ReactMouseEvent,
  Ref,
} from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

import { EntryNameCell } from "../entry-name-cell";
import { iconForEntry } from "../icons";
import { ErrorPin, PendingOpGlyph } from "../pending-op-visuals";
import type { ExplorerStore } from "../store";

/**
 * IconAboveNameCell — shared presentational cell shape for the two
 * vertical-stack view modes: Medium Icons (64 px / `size-16`) and
 * Large Icons (96 px / `size-24`). Per design.md Decision 3 the
 * two modes are structurally identical — icon above name, no
 * metadata lines — differing only in icon size and the cell's
 * surrounding grid track width.
 *
 * The cell is deliberately presentational: no store dependency, no
 * `useSyncExternalStore`, no selection state. The parent view mode
 * owns that wiring and hands the cell pre-computed `selected` and
 * `pending` booleans plus a bound `onClick`. Tests exercise the
 * helper indirectly through the two view-mode test files.
 *
 * `iconSize` is typed as the exact Tailwind utility the view modes
 * need rather than a generic `string` so future renames of
 * `size-16`/`size-24` fail at the call site (and in tests) rather
 * than silently compile.
 */

export type IconAboveNameCellSize = "size-16" | "size-24";

export interface IconAboveNameCellProps
  extends ComponentPropsWithoutRef<"div"> {
  /**
   * Optional so existing presentational view-mode tests can still mount
   * without a store; when present, the inline-rename UI activates for
   * this cell while editingId matches entry.id.
   */
  store?: ExplorerStore;
  entry: FileEntry;
  iconSize: IconAboveNameCellSize;
  selected: boolean;
  pending: boolean;
  // Optional props: existing standalone view-mode tests mount without
  // these; parent view modes supply them for the remove/error flows.
  pendingKind?: "rename" | "remove" | null;
  errorReason?: string | null;
  /**
   * Phase 4 roving-focus state. Optional so the presentational cell can
   * still render standalone from its existing view-mode tests.
   */
  focused?: boolean;
  onClick: (event: ReactMouseEvent) => void;
  ref?: Ref<HTMLDivElement>;
}

export function IconAboveNameCell({
  store,
  entry,
  iconSize,
  selected,
  pending,
  pendingKind = null,
  errorReason = null,
  focused = false,
  onClick,
  ref: externalRef,
  ...rest
}: IconAboveNameCellProps) {
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
      role="gridcell"
      data-testid="explorer-cell"
      data-entry-id={entry.id}
      data-entry-kind={entry.kind}
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      onClick={onClick}
      className={cn(
        "flex cursor-default flex-col items-center gap-2 rounded-md p-3 outline-none",
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
        className={cn("text-muted-foreground", iconSize)}
      />
      <div className="flex w-full items-center justify-center gap-1.5">
        {store !== undefined ? (
          <EntryNameCell
            store={store}
            entry={entry}
            className={cn(
              "max-w-full text-center text-sm",
              pendingKind === "remove" && "line-through",
            )}
          />
        ) : (
          <span
            className={cn(
              "max-w-full truncate text-center text-sm",
              pendingKind === "remove" && "line-through",
            )}
          >
            {entry.name}
          </span>
        )}
        {pending ? <PendingOpGlyph /> : null}
        {errorReason !== null ? <ErrorPin reason={errorReason} /> : null}
      </div>
    </div>
  );
}
