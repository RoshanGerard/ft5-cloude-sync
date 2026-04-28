"use client";

//
// RenameConflictDialog (add-engine-rename-download §25) — single-collision
// re-prompt for the inline-rename flow.
//
// `store.rename` dispatches `files.rename` with `conflictPolicy: "fail"`
// by default. On a `tag: "conflict"` envelope, the store invokes the
// registered `RenameConflictPrompt` (port from `store.ts`). This module
// provides the production `useRenameConflictDialog()` hook that wires
// the port to a controlled dialog rendered with the same shadcn primitives
// + amber-Overwrite styling as the upload `ConflictResolutionDialog`.
//
// Why a parallel dialog (not the upload one): the upload dialog is shaped
// for a queue walk (`ConflictInfo` carrying file/existing metadata + an
// "Apply to remaining N conflicts" checkbox + choices "overwrite" /
// "duplicate" / "skip"). Rename has only `existingPath`, no batch context,
// and choices "overwrite" / "keep-both" / cancel. See
// add-engine-rename-download/design.md Decision 7 (renderer-wiring
// deviation note 2026-04-28).
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

import type {
  RenameConflictChoice,
  RenameConflictPrompt,
} from "./store";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RenameConflictDialogProps {
  readonly open: boolean;
  readonly existingPath: string | null;
  readonly onChoice: (choice: "overwrite" | "keep-both") => void;
  readonly onCancel: () => void;
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
}: RenameConflictDialogProps): JSX.Element {
  // Radix routes Escape / overlay-click / close-button through onOpenChange.
  // Map dismissal to a Cancel choice so `store.rename` exits cleanly.
  const handleOpenChange = (next: boolean): void => {
    if (!next) onCancel();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>File already exists</DialogTitle>
          <DialogDescription>
            A file at this path already exists. Choose what to do for this
            rename.
          </DialogDescription>
        </DialogHeader>

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
