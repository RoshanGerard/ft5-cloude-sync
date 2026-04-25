/** @vitest-environment jsdom */
//
// ConflictResolutionDialog — Task 7.1 failing tests.
//
// Cases (per tasks.md 7.1):
//   (a) Serial walk through N conflicts; default checkbox unchecked.
//   (b) "Apply to remaining" checkbox short-circuits further prompts
//       with the last-chosen policy.
//   (c) "Cancel all" resolves the promise with `{ aborted: true }`.
//   (d) "Keep both" resolves the per-file choice with `kind: "duplicate"`.
//
// These are integration-style assertions on the resolver promise return
// value. Walking-logic correctness is owned by `resolve-conflicts.test.ts`;
// here we only verify the dialog wiring (button → resolver promise).

import {
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useEffect, useRef, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConflictResolutionDialog,
  useConflictResolutionDialog,
} from "../conflict-resolution-dialog.js";
import type { ConflictChoice, ConflictInfo } from "../resolve-conflicts.js";

type Resolved =
  | { aborted: false; choices: readonly ConflictChoice[] }
  | { aborted: true };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConflict(name: string): ConflictInfo {
  return {
    file: {
      sourcePath: `/local/${name}`,
      basename: name,
      sizeBytes: 1234,
    },
    targetPath: `/dest/${name}`,
    existing: {
      sizeBytes: 5678,
      modifiedAt: "2026-04-01T00:00:00.000Z",
    },
  };
}

// ---------------------------------------------------------------------------
// Test harness — surfaces the hook's `resolver.resolve(...)` to tests via
// a `start` callback prop, and renders the dialog with the hook's props.
// ---------------------------------------------------------------------------

interface HarnessProps {
  readonly conflicts: readonly ConflictInfo[];
  readonly onResolved: (result: Resolved) => void;
}

function Harness({ conflicts, onResolved }: HarnessProps): JSX.Element {
  const { resolver, dialogProps } = useConflictResolutionDialog();
  const started = useRef(false);
  // Kick off resolve() once on mount; tests then drive the dialog.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void resolver.resolve(conflicts).then(onResolved);
  }, [conflicts, onResolved, resolver]);
  return <ConflictResolutionDialog {...dialogProps} />;
}

interface RenderHarnessResult {
  readonly result: RenderResult;
  readonly resolved: () => Promise<Resolved>;
}

function renderHarness(
  conflicts: readonly ConflictInfo[],
): RenderHarnessResult {
  let resolveOuter: (v: Resolved) => void = () => {};
  const promise = new Promise<Resolved>((res) => {
    resolveOuter = res;
  });
  const result = render(
    <Harness conflicts={conflicts} onResolved={(v) => resolveOuter(v)} />,
  );
  return { result, resolved: () => promise };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // shadcn dialog uses Radix which queries ResizeObserver in jsdom.
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      };
  }
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConflictResolutionDialog", () => {
  // (a)
  it("walks conflicts serially with the apply-to-remaining checkbox unchecked by default", async () => {
    const conflictA = makeConflict("a.pdf");
    const conflictB = makeConflict("b.pdf");
    const { resolved } = renderHarness([conflictA, conflictB]);

    // First prompt: shows a.pdf and an unchecked checkbox.
    await screen.findByText("a.pdf");
    const checkbox = screen.getByRole("checkbox", { name: /apply/i });
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText("b.pdf")).not.toBeInTheDocument();

    // Click Overwrite — dialog advances to b.pdf.
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    await screen.findByText("b.pdf");
    expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
    // Checkbox state resets between prompts.
    expect(screen.getByRole("checkbox", { name: /apply/i })).not.toBeChecked();

    // Click Skip this file — promise resolves with both choices.
    fireEvent.click(screen.getByRole("button", { name: "Skip this file" }));

    const result = await resolved();
    expect(result).toEqual({
      aborted: false,
      choices: [{ kind: "overwrite" }, { kind: "skip" }],
    });
  });

  // (b)
  it("short-circuits remaining prompts when the user ticks 'Apply to remaining'", async () => {
    const conflicts = [
      makeConflict("a.pdf"),
      makeConflict("b.pdf"),
      makeConflict("c.pdf"),
    ];
    const { resolved } = renderHarness(conflicts);

    await screen.findByText("a.pdf");

    // Tick the checkbox, then choose Overwrite.
    const checkbox = screen.getByRole("checkbox", { name: /apply/i });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    const result = await resolved();
    expect(result).toEqual({
      aborted: false,
      choices: [
        { kind: "overwrite" },
        { kind: "overwrite" },
        { kind: "overwrite" },
      ],
    });
    // Other files were never displayed — only one prompt rendered.
    expect(screen.queryByText("b.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("c.pdf")).not.toBeInTheDocument();
  });

  // (c)
  it("aborts the batch when the user clicks 'Cancel all'", async () => {
    const conflicts = [makeConflict("a.pdf"), makeConflict("b.pdf")];
    const { resolved } = renderHarness(conflicts);

    await screen.findByText("a.pdf");

    fireEvent.click(screen.getByRole("button", { name: "Cancel all" }));

    const result = await resolved();
    expect(result).toEqual({ aborted: true });
  });

  // (d)
  it("records 'duplicate' when the user picks 'Keep both'", async () => {
    const conflict = makeConflict("a.pdf");
    const { resolved } = renderHarness([conflict]);

    await screen.findByText("a.pdf");

    fireEvent.click(screen.getByRole("button", { name: "Keep both" }));

    const result = await resolved();
    expect(result).toEqual({
      aborted: false,
      choices: [{ kind: "duplicate" }],
    });
  });

  // Sanity: header text matches the visual contract.
  it("renders the dialog title 'File already exists'", async () => {
    const { resolved: _resolved } = renderHarness([makeConflict("a.pdf")]);
    await screen.findByRole("heading", { name: /File already exists/i });
  });
});

