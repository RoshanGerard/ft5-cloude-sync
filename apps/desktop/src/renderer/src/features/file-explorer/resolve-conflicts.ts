// Pure, testable "walk conflicts serially + honor Apply to remaining"
// helper. The Task 7 conflict-resolution dialog drives this helper from
// inside its own `ConflictResolver.resolve` implementation — the
// orchestrator itself only sees the opaque `ConflictResolver` port.

export interface UploadFileItem {
  readonly sourcePath: string;
  readonly basename: string;
  readonly sizeBytes?: number;
}

export interface ConflictInfo {
  readonly file: UploadFileItem;
  readonly targetPath: string;
  readonly existing: {
    readonly sizeBytes: number | null;
    readonly modifiedAt: string;
  };
}

export type ConflictChoice =
  | { readonly kind: "overwrite" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "skip" };

export interface ConflictPrompt {
  /**
   * Ask the user about ONE conflict. Returns their choice + whether it
   * should apply to all remaining conflicts, or `{ kind: "cancel" }` to
   * abort the whole batch.
   */
  ask(
    conflict: ConflictInfo,
  ): Promise<
    | {
        readonly kind: "choice";
        readonly choice: ConflictChoice;
        readonly applyToRemaining: boolean;
      }
    | { readonly kind: "cancel" }
  >;
}

/**
 * Serially prompt for each conflict. Once the user ticks "Apply to
 * remaining" on any prompt, the same choice is applied to every
 * following conflict without asking again. Cancel terminates the walk
 * immediately and returns `{ aborted: true }`.
 */
export async function resolveConflicts(
  conflicts: readonly ConflictInfo[],
  prompt: ConflictPrompt,
): Promise<
  | { aborted: false; choices: readonly ConflictChoice[] }
  | { aborted: true }
> {
  const choices: ConflictChoice[] = [];
  let autoApply: ConflictChoice | null = null;
  for (const conflict of conflicts) {
    if (autoApply !== null) {
      choices.push(autoApply);
      continue;
    }
    const response = await prompt.ask(conflict);
    if (response.kind === "cancel") {
      return { aborted: true };
    }
    choices.push(response.choice);
    if (response.applyToRemaining) {
      autoApply = response.choice;
    }
  }
  return { aborted: false, choices };
}
