"use client";

//
// RenameConflictDialog (add-engine-rename-download §25) — single-collision
// re-prompt for the inline-rename flow. Reused by add-download-overwrite-confirm
// §6 for the `files:download` conflict gate via prop-extracted title /
// description / hint metadata; the component name is kept (per design.md
// Decision 5 — minimum churn; a future mechanical rename to
// `ConflictResolutionDialog` is a clean follow-up).
//
// `store.rename` dispatches `files.rename` with `conflictPolicy: "fail"`
// by default. On a `tag: "conflict"` envelope, the store invokes the
// registered `RenameConflictPrompt` (port from `store.ts`). This module
// provides the production `useRenameConflictDialog()` hook that wires
// the port to a controlled dialog rendered with the same shadcn primitives
// + amber-Overwrite styling as the upload `ConflictResolutionDialog`.
//
// add-download-overwrite-confirm §6 reuses the same controlled component
// with `title` / `description` / `existingSize` / `existingModifiedAt`
// supplied by the download caller; defaults preserve the rename copy and
// the hint block is omitted entirely when both hint fields are absent
// (so existing rename callsites render unchanged). The companion
// `useDownloadConflictDialog()` hook in this module wires the
// `DownloadConflictPrompt` port through to the same controlled component.
//
// Why a parallel dialog (not the upload one): the upload dialog is shaped
// for a queue walk (`ConflictInfo` carrying file/existing metadata + an
// "Apply to remaining N conflicts" checkbox + choices "overwrite" /
// "duplicate" / "skip"). Rename + download both surface a single collision,
// no batch context, and choices "overwrite" / "keep-both" / cancel. See
// add-engine-rename-download/design.md Decision 7 (renderer-wiring
// deviation note 2026-04-28) and add-download-overwrite-confirm/design.md
// Decision 5.
//

import { useCallback, useMemo, useRef, useState, type JSX } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { formatDate, formatSize } from "./view-modes/details-format";
import type {
  DownloadConflictChoice,
  DownloadConflictPrompt,
  RenameConflictChoice,
  RenameConflictPrompt,
} from "./store";

// ---------------------------------------------------------------------------
// Default copy — matches the pre-§6 rename-only wording verbatim. The
// download callsite passes its own strings (see `useDownloadConflictDialog`
// below).
// ---------------------------------------------------------------------------

const DEFAULT_RENAME_TITLE = "File already exists";
const DEFAULT_RENAME_DESCRIPTION =
  "A file at this path already exists. Choose what to do for this rename.";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RenameConflictDialogProps {
  readonly open: boolean;
  readonly existingPath: string | null;
  readonly onChoice: (choice: "overwrite" | "keep-both") => void;
  readonly onCancel: () => void;
  /**
   * Optional title override. Defaults to the rename copy
   * ("File already exists"); the download caller passes its own copy
   * ("Download destination already exists"). Per design.md Decision 5 —
   * extract the two strings as props rather than minting a sister
   * component, since the matrix is identical (overwrite / keep-both /
   * cancel) and only the surrounding copy differs.
   */
  readonly title?: string;
  /**
   * Optional description override. Defaults to the rename copy
   * ("A file at this path already exists. Choose what to do for this
   * rename.").
   */
  readonly description?: string;
  /**
   * Optional size hint (bytes) for the existing file at the conflict
   * path. Populated by the `files:download` conflict gate from
   * `fs.stat(toPath).size`. Renders as the size segment of a single
   * "<formatted-size> · modified <formatted-date>" hint line above the
   * existing-path block. Omitted entirely when both `existingSize` and
   * `existingModifiedAt` are absent (so existing rename callsites that
   * don't populate either field continue to render path-only).
   */
  readonly existingSize?: number;
  /**
   * Optional ISO 8601 mtime hint for the existing file at the conflict
   * path. Populated by the `files:download` conflict gate from
   * `fs.stat(toPath).mtime.toISOString()`. Formatted via
   * `formatDate` (the same en-US absolute-date helper the file list's
   * "modified" column uses); the design's "2 minutes ago" example string
   * is aspirational — its instruction "the existing time-formatter used
   * for the file list 'modified' column" anchors on the absolute
   * formatter to honour the "no new dep" rule (no
   * `Intl.RelativeTimeFormat` adapter introduced for this single field).
   */
  readonly existingModifiedAt?: string;
}

export interface UseRenameConflictDialogResult {
  readonly prompt: RenameConflictPrompt;
  readonly dialogProps: RenameConflictDialogProps;
}

// ---------------------------------------------------------------------------
// Controlled component
// ---------------------------------------------------------------------------

export function RenameConflictDialog({
  open,
  existingPath,
  onChoice,
  onCancel,
  title = DEFAULT_RENAME_TITLE,
  description = DEFAULT_RENAME_DESCRIPTION,
  existingSize,
  existingModifiedAt,
}: RenameConflictDialogProps): JSX.Element {
  // Radix routes Escape / overlay-click / close-button through onOpenChange.
  // Map dismissal to a Cancel choice so the store's conflict loop exits
  // cleanly (rename and download share the same dismissal contract).
  const handleOpenChange = (next: boolean): void => {
    if (!next) onCancel();
  };

  // Hint line — renders only when at least one hint field is present. The
  // existing rename callsite (which omits both fields) keeps its
  // path-only block unchanged. Format reuses `formatSize` + `formatDate`
  // (the same pair the upload conflict dialog uses) so visual + numeric
  // conventions stay aligned across all three conflict surfaces; per
  // add-download-overwrite-confirm/design.md "no new dep" rule.
  const hasSize = typeof existingSize === "number";
  const hasModified =
    typeof existingModifiedAt === "string" && existingModifiedAt.length > 0;
  const renderHint = hasSize || hasModified;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {renderHint ? (
          <div
            className="text-muted-foreground text-xs"
            data-testid="rename-conflict-existing-hint"
          >
            {hasSize ? formatSize(existingSize as number) : null}
            {hasSize && hasModified ? " · " : null}
            {hasModified ? (
              <>modified {formatDate(existingModifiedAt as string)}</>
            ) : null}
          </div>
        ) : null}

        {existingPath ? (
          <div
            className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"
            data-testid="rename-conflict-existing-path"
          >
            <div className="font-mono text-xs text-amber-900">
              {existingPath}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            onClick={() => onChoice("overwrite")}
            className={cn(
              "bg-amber-600 text-white hover:bg-amber-700 focus-visible:ring-amber-600/40",
            )}
          >
            Overwrite
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onChoice("keep-both")}
          >
            Keep both
          </Button>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Hook — state + RenameConflictPrompt port
// ---------------------------------------------------------------------------

export function useRenameConflictDialog(): UseRenameConflictDialogResult {
  const [open, setOpen] = useState(false);
  const [existingPath, setExistingPath] = useState<string | null>(null);

  // Pending `prompt` resolver. Set by `prompt(...)`, consumed by
  // `onChoice` / `onCancel` exactly once per prompt.
  const resolveRef = useRef<((c: RenameConflictChoice) => void) | null>(null);

  const prompt: RenameConflictPrompt = useMemo(
    () => async (path: string) => {
      setExistingPath(path);
      setOpen(true);
      const choice = await new Promise<RenameConflictChoice>((res) => {
        resolveRef.current = res;
      });
      resolveRef.current = null;
      setOpen(false);
      setExistingPath(null);
      return choice;
    },
    [],
  );

  const onChoice = useCallback(
    (choice: "overwrite" | "keep-both"): void => {
      const res = resolveRef.current;
      if (!res) return;
      resolveRef.current = null;
      res(choice);
    },
    [],
  );

  const onCancel = useCallback((): void => {
    const res = resolveRef.current;
    if (!res) return;
    resolveRef.current = null;
    res("cancel");
  }, []);

  return {
    prompt,
    dialogProps: {
      open,
      existingPath,
      onChoice,
      onCancel,
    },
  };
}

// ---------------------------------------------------------------------------
// Download-conflict dialog hook (add-download-overwrite-confirm §6.5)
//
// Parallel to `useRenameConflictDialog` rather than parameterised. Per
// the advisor / Phase E re-anchor: a parameterised
// `useRenameConflictDialog(mode: "rename" | "download")` would force
// threading a mode prop through the rename callsite (already wired and
// tested), while two hooks → two `setX` setters → matches the existing
// rename mount pattern verbatim. Two hooks share the same controlled
// `RenameConflictDialog` component (different props) but own
// independent prompt-resolver state so a rename and a download conflict
// can never collide on the same mount.
// ---------------------------------------------------------------------------

const DOWNLOAD_CONFLICT_TITLE = "Download destination already exists";
const DOWNLOAD_CONFLICT_DESCRIPTION =
  "A file already exists at the download destination. Choose how to proceed.";

// Same shape as RenameConflictDialogProps; aliased so the download caller's
// `<RenameConflictDialog {...dialogProps} />` reads as a download-mode dialog
// at the call site without renaming the underlying component (per
// design.md Decision 5).
export type DownloadConflictDialogProps = RenameConflictDialogProps;

export interface UseDownloadConflictDialogResult {
  readonly prompt: DownloadConflictPrompt;
  readonly dialogProps: DownloadConflictDialogProps;
}

export function useDownloadConflictDialog(): UseDownloadConflictDialogResult {
  const [open, setOpen] = useState(false);
  const [existingPath, setExistingPath] = useState<string | null>(null);
  const [existingSize, setExistingSize] = useState<number | undefined>(
    undefined,
  );
  const [existingModifiedAt, setExistingModifiedAt] = useState<
    string | undefined
  >(undefined);

  const resolveRef = useRef<((c: DownloadConflictChoice) => void) | null>(null);

  const prompt: DownloadConflictPrompt = useMemo(
    () =>
      async (path, size, modifiedAt) => {
        setExistingPath(path);
        setExistingSize(size);
        setExistingModifiedAt(modifiedAt);
        setOpen(true);
        const choice = await new Promise<DownloadConflictChoice>((res) => {
          resolveRef.current = res;
        });
        resolveRef.current = null;
        setOpen(false);
        setExistingPath(null);
        setExistingSize(undefined);
        setExistingModifiedAt(undefined);
        return choice;
      },
    [],
  );

  const onChoice = useCallback(
    (choice: "overwrite" | "keep-both"): void => {
      const res = resolveRef.current;
      if (!res) return;
      resolveRef.current = null;
      res(choice);
    },
    [],
  );

  const onCancel = useCallback((): void => {
    const res = resolveRef.current;
    if (!res) return;
    resolveRef.current = null;
    res("cancel");
  }, []);

  return {
    prompt,
    dialogProps: {
      open,
      existingPath,
      onChoice,
      onCancel,
      title: DOWNLOAD_CONFLICT_TITLE,
      description: DOWNLOAD_CONFLICT_DESCRIPTION,
      existingSize,
      existingModifiedAt,
    },
  };
}
