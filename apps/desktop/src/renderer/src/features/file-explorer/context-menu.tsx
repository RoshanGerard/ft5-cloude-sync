"use client";

import type { JSX, ReactNode } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/**
 * FileContextMenu — the right-click / Shift+F10 menu for a file-explorer
 * entry, per the "Right-click context menu offers Open, Download,
 * Rename, Delete, Copy path, Properties" requirement in
 * `openspec/changes/ui-file-explorer/specs/file-explorer/spec.md`.
 *
 * Items appear in exactly this order:
 *   1. Open
 *   2. Download
 *   3. Rename          (disabled when `entry.kind === "directory"`)
 *   4. Delete
 *   5. Copy path
 *   6. Properties
 *
 * Directory rename is a v1 Non-Goal (design.md) — disabling the Rename
 * item is the natural affordance; Radix suppresses `onSelect` on disabled
 * items and sets `aria-disabled="true"`, satisfying the "Activating it
 * does nothing" scenario without extra wiring.
 *
 * Each callback is optional so the parent explorer can wire them
 * progressively: Phase 5 adds the Properties modal, Phase 6 adds rename
 * / delete / download. For Copy path we write to
 * `navigator.clipboard.writeText(entry.path)` when the API is available;
 * jsdom is a silent no-op. Phase 9 hardens this (error surfacing via a
 * `sonner` toast).
 *
 * Programmatic open-on-keypress (Shift+F10 / ContextMenu key) is handled
 * by the caller: `useKeyboardNav` exposes an `onContextMenuRequested`
 * callback that fires with the currently-focused entry, and the
 * composite explorer wires it to `ContextMenu.onOpenChange` at the
 * matching entry element. Radix natively handles pointer-driven right
 * clicks via the wrapped trigger; we don't need to listen for DOM
 * `contextmenu` events ourselves.
 *
 * Focus restoration: Radix restores focus to the trigger element when
 * the menu closes (Escape, outside click, selection). For that to work,
 * `children` must be a focusable element — view-mode rows already
 * render with `tabIndex=0` / `-1` under roving-tabindex, so passing the
 * row as `children` inside `<ContextMenuTrigger asChild>` picks up the
 * existing focus target.
 */
export interface FileContextMenuProps {
  entry: FileEntry;
  children: ReactNode;
  onOpen?: (entry: FileEntry) => void;
  onDownload?: (entry: FileEntry) => void;
  onRename?: (entry: FileEntry) => void;
  onDelete?: (entry: FileEntry) => void;
  onCopyPath?: (entry: FileEntry) => void;
  onProperties?: (entry: FileEntry) => void;
}

export function FileContextMenu(props: FileContextMenuProps): JSX.Element {
  const {
    entry,
    children,
    onOpen,
    onDownload,
    onRename,
    onDelete,
    onCopyPath,
    onProperties,
  } = props;

  const renameDisabled = entry.kind === "directory";
  // Directory download is a v1 silent no-op in the store (design.md
  // Decision 7 — downloads operate per-file, folder download would
  // imply a zip-ish bundle we don't own yet). Disable the item here so
  // the no-op is honest at the menu level rather than silently
  // swallowed when selected.
  const downloadDisabled = entry.kind === "directory";

  const handleCopyPath = (): void => {
    const clipboard =
      typeof navigator !== "undefined"
        ? (navigator as Navigator & { clipboard?: { writeText?: (s: string) => Promise<void> } }).clipboard
        : undefined;
    if (clipboard && typeof clipboard.writeText === "function") {
      void clipboard.writeText(entry.path);
    }
    onCopyPath?.(entry);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="file-context-menu">
        <ContextMenuItem onSelect={() => onOpen?.(entry)}>Open</ContextMenuItem>
        <ContextMenuItem
          disabled={downloadDisabled}
          onSelect={() => onDownload?.(entry)}
        >
          Download
        </ContextMenuItem>
        <ContextMenuItem
          disabled={renameDisabled}
          onSelect={() => onRename?.(entry)}
        >
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={() => onDelete?.(entry)}
        >
          Delete
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleCopyPath}>Copy path</ContextMenuItem>
        <ContextMenuItem onSelect={() => onProperties?.(entry)}>
          Properties
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
