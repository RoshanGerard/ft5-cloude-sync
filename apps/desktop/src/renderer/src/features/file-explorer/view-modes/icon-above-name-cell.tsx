"use client";

import { useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

import { iconForEntry } from "../icons.js";

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

export interface IconAboveNameCellProps {
  entry: FileEntry;
  iconSize: IconAboveNameCellSize;
  selected: boolean;
  pending: boolean;
  /**
   * Phase 4 roving-focus state. Optional so the presentational cell can
   * still render standalone from its existing view-mode tests.
   */
  focused?: boolean;
  onClick: (event: ReactMouseEvent) => void;
}

export function IconAboveNameCell({
  entry,
  iconSize,
  selected,
  pending,
  focused = false,
  onClick,
}: IconAboveNameCellProps) {
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
      data-testid="explorer-cell"
      data-entry-id={entry.id}
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      onClick={onClick}
      className={cn(
        "flex cursor-default flex-col items-center gap-2 rounded-md p-3 outline-none",
        "hover:bg-accent/50",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        selected && "bg-accent",
        pending && "opacity-60 animate-sync-pulse",
        focused && "ring-ring ring-2 ring-inset",
      )}
    >
      <Icon
        name={iconName}
        aria-hidden
        className={cn("text-muted-foreground", iconSize)}
      />
      <span className="max-w-full truncate text-center text-sm">
        {entry.name}
      </span>
    </div>
  );
}
