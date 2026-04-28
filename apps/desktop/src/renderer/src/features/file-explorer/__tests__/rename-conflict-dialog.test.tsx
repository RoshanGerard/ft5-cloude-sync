/** @vitest-environment jsdom */
//
// RenameConflictDialog (add-engine-rename-download §25).
//
// Thin coverage of the controlled component + the `useRenameConflictDialog`
// hook's prompt port. Heavy-lifting loop logic (initial dispatch with
// `"fail"`, re-dispatch with the user's policy, pendingOp refresh) lives
// in `store.test.ts`'s "rename action — conflict re-prompt (§25)" block.
// Here we only verify the wiring: dialog renders the existingPath; clicking
// each button resolves the prompt with the matching choice; closing the
// dialog (Cancel button or onOpenChange→false) resolves with `"cancel"`.
//

import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { useEffect, useRef, type JSX } from "react";

import {
  RenameConflictDialog,
  useRenameConflictDialog,
} from "../rename-conflict-dialog.js";
import type { RenameConflictChoice } from "../store.js";

// ---------------------------------------------------------------------------
// Test harness — exposes the hook's `prompt` to tests via a `start` callback
// prop. Mirrors `conflict-resolution-dialog.test.tsx`'s harness.
// ---------------------------------------------------------------------------

interface HarnessProps {
  readonly existingPath: string;
  readonly onResolved: (choice: RenameConflictChoice) => void;
}

function Harness({ existingPath, onResolved }: HarnessProps): JSX.Element {
  const { prompt, dialogProps } = useRenameConflictDialog();
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void prompt(existingPath).then(onResolved);
  }, [prompt, existingPath, onResolved]);
  return <RenameConflictDialog {...dialogProps} />;
}

afterEach(() => {
  cleanup();
});

describe("RenameConflictDialog (§25)", () => {
  it("renders the existingPath when open", async () => {
    const noop = (): void => {};
    render(<Harness existingPath="/parent/bar.pdf" onResolved={noop} />);
    expect(
      await screen.findByText(/parent\/bar\.pdf/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Overwrite" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keep both" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel" }),
    ).toBeInTheDocument();
  });

  it("Overwrite click resolves the prompt with 'overwrite'", async () => {
    const resolved: RenameConflictChoice[] = [];
    const onResolved = (choice: RenameConflictChoice): void => {
      resolved.push(choice);
    };
    render(<Harness existingPath="/x/y" onResolved={onResolved} />);
    const overwrite = await screen.findByRole("button", { name: "Overwrite" });
    fireEvent.click(overwrite);
    // microtask flush
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toEqual(["overwrite"]);
  });

  it("Keep both click resolves the prompt with 'keep-both'", async () => {
    const resolved: RenameConflictChoice[] = [];
    const onResolved = (choice: RenameConflictChoice): void => {
      resolved.push(choice);
    };
    render(<Harness existingPath="/x/y" onResolved={onResolved} />);
    const keepBoth = await screen.findByRole("button", { name: "Keep both" });
    fireEvent.click(keepBoth);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toEqual(["keep-both"]);
  });

  it("Cancel button resolves the prompt with 'cancel'", async () => {
    const resolved: RenameConflictChoice[] = [];
    const onResolved = (choice: RenameConflictChoice): void => {
      resolved.push(choice);
    };
    render(<Harness existingPath="/x/y" onResolved={onResolved} />);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancel);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toEqual(["cancel"]);
  });

  it("controlled component does not render when open=false", () => {
    let result: RenderResult | null = null;
    result = render(
      <RenameConflictDialog
        open={false}
        existingPath="/x/y"
        onChoice={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(result.queryByText(/x\/y/)).toBeNull();
  });
});
