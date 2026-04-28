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

/**
 * FileContextMenu — the right-click / Shift+F10 menu for a file-explorer
 * entry, per the "Right-click context menu offers Open, Download,
 * Rename, Delete, Copy path, Properties" requirement in
 * `openspec/changes/ui-file-explorer/specs/file-explorer/spec.md`.
 *
 * Items appear in exactly this order:
 *   1. Open
 *   2. Download         (disabled for directories — folder download
 *                        is out of scope for v1)
 *   3. Rename           (disabled for S3 + mock directories;
 *                        Drive / OneDrive directories rename via the
 *                        engine's strategy)
 *   4. Delete
 *   5. Copy path
 *   6. Properties
 *
 * Disabled items keep keyboard focus reachable and surface a tooltip via
 * `title`. Radix suppresses `onSelect` on disabled items and sets
 * `aria-disabled="true"`, satisfying the "Activating it does nothing"
 * scenario without extra wiring. See
 * `openspec/changes/add-engine-rename-download/specs/file-explorer/spec.md`
 * § "Rename and Download affordances are enabled with provider-
 * conditional folder rename" for the canonical rule.
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

  // Rename / Download affordances are now wired end-to-end through the
  // engine (`add-engine-rename-download` § Rename and Download
  // affordances are enabled with provider-conditional folder rename).
  // The narrower disable rules:
  //   - Rename: enabled for files everywhere; enabled for Drive /
  //     OneDrive directories; disabled for S3 directories with a
  //     provider-specific tooltip; disabled for mock directories with
  //     the existing v1 tooltip.
  //   - Download: enabled for files everywhere; disabled for
  //     directories with the v1 tooltip (folder-download is out of
  //     scope for this change).
  const providerKind = useProviderKind();
  const isDirectory = entry.kind === "directory";
  const renameDisabled =
    isDirectory && (providerKind === "s3" || providerKind === "mock");
  const downloadDisabled = isDirectory;
  const renameTooltip = !isDirectory
    ? undefined
    : providerKind === "s3"
      ? "Folder rename isn't supported on S3"
      : providerKind === "mock"
        ? "Folder rename is not supported in this version"
        : undefined;
  const downloadTooltip = isDirectory
    ? "Folder download is not supported in this version"
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
