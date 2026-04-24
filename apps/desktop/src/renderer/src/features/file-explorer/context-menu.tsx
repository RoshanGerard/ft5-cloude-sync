"use client";

import type { JSX, ReactNode } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import { useProviderKind } from "./provider-kind-context";
import { isEngineBacked } from "./search-results";

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

  // Engine-backed datasources disable Rename and Download until
  // `add-engine-rename-download` wires the real operations (see
  // wire-file-explorer-to-service spec § Rename and Download
  // affordances). The legacy directory disable still applies on
  // mock datasources.
  const engineBacked = isEngineBacked(useProviderKind());
  const renameDisabled = engineBacked || entry.kind === "directory";
  const downloadDisabled = engineBacked || entry.kind === "directory";
  const renameTooltip = engineBacked
    ? "Rename is coming in a future release (see change add-engine-rename-download)"
    : entry.kind === "directory"
      ? "Folder rename is not supported in this version"
      : undefined;
  const downloadTooltip = engineBacked
    ? "Download is coming in a future release (see change add-engine-rename-download)"
    : undefined;

  const handleCopyPath = (): void => {
    // Use window.api.clipboard (main-process bridge) rather than
    // navigator.clipboard; the latter is flaky under Radix context-menu
    // focus handling in packaged Electron. Fall back to navigator for
    // environments where window.api is not yet injected (e.g. renderer
    // unit tests that don't stub the preload).
    const apiWriteText = (
      globalThis as unknown as {
        window?: {
          api?: { clipboard?: { writeText?: (s: string) => Promise<void> } };
        };
      }
    ).window?.api?.clipboard?.writeText;
    if (apiWriteText !== undefined) {
      void apiWriteText(entry.path);
    } else if (
      typeof navigator !== "undefined" &&
      typeof navigator.clipboard?.writeText === "function"
    ) {
      void navigator.clipboard.writeText(entry.path);
    }
    onCopyPath?.(entry);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="file-context-menu">
        <ContextMenuItem onSelect={() => onOpen?.(entry)}>Open</ContextMenuItem>
        <ContextMenuItem
          data-testid="file-context-menu-download"
          disabled={downloadDisabled}
          title={downloadTooltip}
          onSelect={() => onDownload?.(entry)}
        >
          Download
        </ContextMenuItem>
        <ContextMenuItem
          data-testid="file-context-menu-rename"
          disabled={renameDisabled}
          title={renameTooltip}
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
