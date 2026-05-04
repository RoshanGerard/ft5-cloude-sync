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

// ---------------------------------------------------------------------------
// Download-mode rendering (add-download-overwrite-confirm §6).
//
// The dialog component is reused for the `files:download` conflict gate —
// `title`, `description`, `existingSize`, and `existingModifiedAt` become
// optional props. Defaults preserve the rename copy (so existing rename
// callsites render unchanged); the download caller passes its own copy plus
// the two hint fields. The hint block renders `"<formatted-size> · modified
// <formatted-date>"` above the existing-path block when at least one hint
// field is present, and is omitted entirely otherwise. Per design.md
// Decision 5 the existing component name is kept; per the design's "no new
// dep" rule, formatting reuses `formatSize` + `formatDate` from
// `view-modes/details-format.ts` (the same pair the upload conflict dialog
// uses) — the design's "2 minutes ago" example string is aspirational; the
// instruction wins ("the existing time-formatter used for the file list
// 'modified' column" === `formatDate` → absolute date).
// ---------------------------------------------------------------------------

describe("RenameConflictDialog — download-mode props (§6)", () => {
  it("renders custom title and description when provided", () => {
    render(
      <RenameConflictDialog
        open={true}
        existingPath="/Users/alice/Downloads/welcome.pdf"
        title="Download destination already exists"
        description="A file already exists at the download destination. Choose how to proceed."
        onChoice={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      screen.getByText("Download destination already exists"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "A file already exists at the download destination. Choose how to proceed.",
      ),
    ).toBeInTheDocument();
  });

  it("falls back to rename copy when title/description omitted (rename-mode unchanged)", () => {
    render(
      <RenameConflictDialog
        open={true}
        existingPath="/x/y"
        onChoice={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("File already exists")).toBeInTheDocument();
    expect(
      screen.getByText(/Choose what to do for this rename/),
    ).toBeInTheDocument();
  });

  it("renders hint block with size + modified date when both fields present", () => {
    render(
      <RenameConflictDialog
        open={true}
        existingPath="/Users/alice/Downloads/welcome.pdf"
        title="Download destination already exists"
        description="A file already exists at the download destination. Choose how to proceed."
        existingSize={4_400_000}
        existingModifiedAt="2026-04-18T12:30:00.000Z"
        onChoice={() => {}}
        onCancel={() => {}}
      />,
    );
    const hint = screen.getByTestId("rename-conflict-existing-hint");
    // formatSize(4_400_000) → 4.2 MB; formatDate of 2026-04-18 → "Apr 18, 2026"
    // (rendered in en-US short by `view-modes/details-format.ts`).
    expect(hint).toHaveTextContent("4.2 MB");
    expect(hint).toHaveTextContent(/modified/);
    expect(hint).toHaveTextContent("Apr 18, 2026");
  });

  it("renders size-only hint when existingModifiedAt omitted", () => {
    render(
      <RenameConflictDialog
        open={true}
        existingPath="/p/f"
        title="Download destination already exists"
        description="..."
        existingSize={1024}
        onChoice={() => {}}
        onCancel={() => {}}
      />,
    );
    const hint = screen.getByTestId("rename-conflict-existing-hint");
    expect(hint).toHaveTextContent("1 KB");
    expect(hint).not.toHaveTextContent(/modified/);
  });

  it("renders modified-only hint when existingSize omitted", () => {
    render(
      <RenameConflictDialog
        open={true}
        existingPath="/p/f"
        title="Download destination already exists"
        description="..."
        existingModifiedAt="2026-04-18T12:30:00.000Z"
        onChoice={() => {}}
        onCancel={() => {}}
      />,
    );
    const hint = screen.getByTestId("rename-conflict-existing-hint");
    expect(hint).toHaveTextContent(/modified/);
    expect(hint).toHaveTextContent("Apr 18, 2026");
    // No size segment — no "MB"/"KB"/"B" unit alongside the modified line.
    expect(hint.textContent).not.toMatch(/\bKB\b|\bMB\b|\bGB\b/);
  });

  it("omits hint block entirely when both hint fields absent (rename callsite unchanged)", () => {
    render(
      <RenameConflictDialog
        open={true}
        existingPath="/p/f"
        onChoice={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(
      screen.queryByTestId("rename-conflict-existing-hint"),
    ).toBeNull();
  });
});
