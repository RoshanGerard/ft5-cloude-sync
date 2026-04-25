"use client";

// Task 7.2 will replace these stubs with the real implementation. The
// surface below is the contract Task 7.1's tests pin: a controlled
// dialog component + a hook that owns queue + applyToRemaining state
// and exposes a `ConflictResolver` whose `.resolve()` wraps the
// existing `resolveConflicts` walker.

import type { JSX } from "react";

import type { ConflictInfo } from "./resolve-conflicts.js";
import type { ConflictResolver } from "./use-upload-orchestrator.js";

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

export function ConflictResolutionDialog(
  _props: ConflictResolutionDialogProps,
): JSX.Element {
  throw new Error("not implemented (Task 7.2)");
}

export function useConflictResolutionDialog(): UseConflictResolutionDialogResult {
  throw new Error("not implemented (Task 7.2)");
}
