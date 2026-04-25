"use client";

//
// ConflictResolutionDialog (Task 7) — preflight conflict prompt.
//
// `useUploadOrchestrator` hands a list of `ConflictInfo` records to a
// `ConflictResolver`; this dialog implements that port. The hook owns
// queue progression and the apply-to-remaining flag; the controlled
// component renders one conflict at a time. The walking semantics
// (serial walk, apply-to-remaining short-circuit, cancel terminates)
// stay in `resolveConflicts` — see resolve-conflicts.ts. We only wire
// button clicks to the helper's `ConflictPrompt.ask` resolver.
//
// Visual contract: design.md § Visual direction "Conflict dialog".
// Buttons "Overwrite" (amber primary), "Keep both" (outline), "Skip
// this file" (outline), "Cancel all" (ghost). Title "File already
// exists". Checkbox "Apply this choice to the remaining N conflicts"
// is hidden when only one conflict is left in the queue.
//

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import {
  resolveConflicts,
  type ConflictChoice,
  type ConflictInfo,
  type ConflictPrompt,
} from "./resolve-conflicts";
import type { ConflictResolver } from "./use-upload-orchestrator";
import { formatDate, formatSize } from "./view-modes/details-format";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ConflictResolutionDialogProps {
  readonly open: boolean;
  readonly current: ConflictInfo | null;
  readonly remainingCount: number;
  readonly applyToRemaining: boolean;
  readonly onApplyToRemainingChange: (next: boolean) => void;
  readonly onChoice: (choice: "overwrite" | "duplicate" | "skip") => void;
  readonly onCancelAll: () => void;
}

export interface UseConflictResolutionDialogResult {
  readonly resolver: ConflictResolver;
  readonly dialogProps: ConflictResolutionDialogProps;
}

// ---------------------------------------------------------------------------
// Controlled component
// ---------------------------------------------------------------------------

export function ConflictResolutionDialog({
  open,
  current,
  remainingCount,
  applyToRemaining,
  onApplyToRemainingChange,
  onChoice,
  onCancelAll,
}: ConflictResolutionDialogProps): JSX.Element {
  // Radix routes Escape / overlay-click / close-button through onOpenChange.
  // Map those into "Cancel all" so the user can dismiss the queue with a key.
  const handleOpenChange = (next: boolean): void => {
    if (!next) onCancelAll();
  };

  const remainingLabel =
    remainingCount === 1
      ? "Apply this choice to the remaining 1 conflict"
      : `Apply this choice to the remaining ${remainingCount} conflicts`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>File already exists</DialogTitle>
          <DialogDescription>
            A file at this path already exists. Choose what to do for this
            upload.
          </DialogDescription>
        </DialogHeader>

        {current ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
            <div className="font-semibold">{current.file.basename}</div>
            <div className="mt-1 text-muted-foreground">
              {formatSize(current.existing.sizeBytes)}
              {" · modified "}
              {formatDate(current.existing.modifiedAt)}
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
            onClick={() => onChoice("duplicate")}
          >
            Keep both
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onChoice("skip")}
          >
            Skip this file
          </Button>
        </div>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={applyToRemaining}
            onCheckedChange={(v) => onApplyToRemainingChange(v === true)}
            aria-label={remainingLabel}
            disabled={remainingCount === 0}
          />
          <span>{remainingLabel}</span>
        </label>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancelAll}>
            Cancel all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Hook — state + ConflictResolver port
// ---------------------------------------------------------------------------

type AskResponse =
  | {
      readonly kind: "choice";
      readonly choice: ConflictChoice;
      readonly applyToRemaining: boolean;
    }
  | { readonly kind: "cancel" };

export function useConflictResolutionDialog(): UseConflictResolutionDialogResult {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ConflictInfo | null>(null);
  const [remainingCount, setRemainingCount] = useState(0);
  const [applyToRemaining, setApplyToRemaining] = useState(false);

  // Ref-mirror so onChoice can read the latest applyToRemaining without
  // re-creating the callback on every toggle (and without forcing the
  // dialog component to re-render whenever the consumer of dialogProps
  // would otherwise see a fresh function identity).
  const applyRef = useRef(applyToRemaining);
  applyRef.current = applyToRemaining;

  // Pending `ConflictPrompt.ask` resolver. Set by `prompt.ask`, consumed
  // by `onChoice` / `onCancelAll` exactly once per prompt.
  const askResolveRef = useRef<((r: AskResponse) => void) | null>(null);

  const resolver: ConflictResolver = useMemo(
    () => ({
      async resolve(conflicts) {
        let index = 0;
        const prompt: ConflictPrompt = {
          ask: (conflict) => {
            // remaining = how many conflicts come AFTER this one in the
            // queue; the walker's apply-to-remaining shortcut would
            // affect that many subsequent prompts.
            const remaining = conflicts.length - index - 1;
            index += 1;
            setApplyToRemaining(false);
            setCurrent(conflict);
            setRemainingCount(remaining);
            setOpen(true);
            return new Promise<AskResponse>((res) => {
              askResolveRef.current = res;
            });
          },
        };
        try {
          return await resolveConflicts(conflicts, prompt);
        } finally {
          askResolveRef.current = null;
          setOpen(false);
          setCurrent(null);
          setRemainingCount(0);
          setApplyToRemaining(false);
        }
      },
    }),
    [],
  );

  const onChoice = useCallback(
    (choice: "overwrite" | "duplicate" | "skip"): void => {
      const res = askResolveRef.current;
      if (!res) return;
      askResolveRef.current = null;
      res({
        kind: "choice",
        choice: { kind: choice } as ConflictChoice,
        applyToRemaining: applyRef.current,
      });
    },
    [],
  );

  const onCancelAll = useCallback((): void => {
    const res = askResolveRef.current;
    if (!res) return;
    askResolveRef.current = null;
    res({ kind: "cancel" });
  }, []);

  return {
    resolver,
    dialogProps: {
      open,
      current,
      remainingCount,
      applyToRemaining,
      onApplyToRemainingChange: setApplyToRemaining,
      onChoice,
      onCancelAll,
    },
  };
}
