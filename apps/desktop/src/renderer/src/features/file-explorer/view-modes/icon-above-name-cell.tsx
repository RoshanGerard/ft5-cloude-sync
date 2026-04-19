"use client";

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
  onClick: (event: ReactMouseEvent) => void;
}

export function IconAboveNameCell({
  entry,
  iconSize,
  selected,
  pending,
  onClick,
}: IconAboveNameCellProps) {
  const iconName = iconForEntry(entry);
  return (
    <div
      role="gridcell"
      data-testid="explorer-cell"
      data-entry-id={entry.id}
      aria-selected={selected}
      tabIndex={0}
      onClick={onClick}
      className={cn(
        "flex cursor-default flex-col items-center gap-2 rounded-md p-3 outline-none",
        "hover:bg-accent/50",
        "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        selected && "bg-accent",
        pending && "opacity-60 animate-sync-pulse",
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
