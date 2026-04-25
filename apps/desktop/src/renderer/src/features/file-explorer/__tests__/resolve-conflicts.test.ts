import { describe, expect, it, vi } from "vitest";

import type {
  ConflictInfo,
  ConflictPrompt,
} from "../resolve-conflicts.js";
import { resolveConflicts } from "../resolve-conflicts.js";

// Pure unit tests for the conflict-resolution walker. The helper is what
// Task 7's dialog will invoke internally; the orchestrator itself only
// knows about `ConflictResolver`. Keeping this surface standalone means
// the "Apply to remaining" short-circuit can be verified without any
// React or Sonner wiring.

function makeConflict(name: string): ConflictInfo {
  return {
    file: {
      sourcePath: `/src/${name}`,
      basename: name,
      sizeBytes: 1234,
    },
    targetPath: `/projects/${name}`,
    existing: {
      sizeBytes: 5678,
      modifiedAt: "2026-04-01T00:00:00.000Z",
    },
  };
}

describe("resolveConflicts", () => {
  it("asks once per conflict when the user does NOT tick 'Apply to remaining'", async () => {
    const conflicts = [
      makeConflict("a.txt"),
      makeConflict("b.txt"),
      makeConflict("c.txt"),
    ];
    const prompt: ConflictPrompt = {
      ask: vi.fn(async () => ({
        kind: "choice" as const,
        choice: { kind: "overwrite" as const },
        applyToRemaining: false,
      })),
    };

    const result = await resolveConflicts(conflicts, prompt);

    expect(prompt.ask).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      aborted: false,
      choices: [
        { kind: "overwrite" },
        { kind: "overwrite" },
        { kind: "overwrite" },
      ],
    });
  });

  it("short-circuits subsequent prompts when 'Apply to remaining' is chosen on the first conflict", async () => {
    const conflicts = [
      makeConflict("a.txt"),
      makeConflict("b.txt"),
      makeConflict("c.txt"),
    ];
    const prompt: ConflictPrompt = {
      ask: vi.fn(async () => ({
        kind: "choice" as const,
        choice: { kind: "duplicate" as const },
        applyToRemaining: true,
      })),
    };

    const result = await resolveConflicts(conflicts, prompt);

    // Only the first conflict should trigger a prompt; the remaining two
    // auto-apply the same choice.
    expect(prompt.ask).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      aborted: false,
      choices: [
        { kind: "duplicate" },
        { kind: "duplicate" },
        { kind: "duplicate" },
      ],
    });
  });

  it("aborts the entire batch when any prompt returns 'cancel'", async () => {
    const conflicts = [
      makeConflict("a.txt"),
      makeConflict("b.txt"),
      makeConflict("c.txt"),
    ];
    let calls = 0;
    const prompt: ConflictPrompt = {
      ask: vi.fn(async () => {
        calls += 1;
        if (calls === 2) return { kind: "cancel" as const };
        return {
          kind: "choice" as const,
          choice: { kind: "skip" as const },
          applyToRemaining: false,
        };
      }),
    };

    const result = await resolveConflicts(conflicts, prompt);

    expect(result).toEqual({ aborted: true });
    expect(prompt.ask).toHaveBeenCalledTimes(2);
  });

  it("handles an empty conflicts list by returning an empty choices array", async () => {
    const prompt: ConflictPrompt = {
      ask: vi.fn(),
    };

    const result = await resolveConflicts([], prompt);

    expect(prompt.ask).not.toHaveBeenCalled();
    expect(result).toEqual({ aborted: false, choices: [] });
  });
});
