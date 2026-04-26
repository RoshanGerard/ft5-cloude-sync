/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ConfirmRemoveDatasourceDialog } from "../confirm-remove-dialog.js";

/**
 * ConfirmRemoveDatasourceDialog — §8 of add-invalid-datasource-state.
 *
 * Spec reference: openspec/changes/add-invalid-datasource-state/specs/
 *   file-explorer/spec.md — "Invalid-datasource Remove flows through a
 *   shared confirm dialog".
 * Design reference: design.md Decision 5 (shared dialog rationale) and
 *   Decision 6 (destructive Remove styling).
 *
 * Pure presentational dialog: parent owns the IPC; this component only
 * collects yes/no via onConfirm / onCancel. Mirrors the structural shape
 * of `confirm-delete-dialog.test.tsx`.
 */

describe("ConfirmRemoveDatasourceDialog — visibility", () => {
  afterEach(() => {
    cleanup();
  });

  it("is not in the DOM when open=false", () => {
    render(
      <ConfirmRemoveDatasourceDialog
        open={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("mounts when open=true", () => {
    render(
      <ConfirmRemoveDatasourceDialog
        open={true}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("ConfirmRemoveDatasourceDialog — copy", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the title 'Remove this datasource?'", () => {
    render(
      <ConfirmRemoveDatasourceDialog
        open={true}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Remove this datasource?");
  });

  it("renders the body 'This deletes the local registry entry; cloud files are not deleted.'", () => {
    render(
      <ConfirmRemoveDatasourceDialog
        open={true}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      "This deletes the local registry entry; cloud files are not deleted.",
    );
  });
});

describe("ConfirmRemoveDatasourceDialog — buttons", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a 'Remove' button with destructive styling", () => {
    render(
      <ConfirmRemoveDatasourceDialog
        open={true}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const removeBtn = screen.getByRole("button", { name: "Remove" });
    // shadcn Button variant="destructive" stamps the `bg-destructive` class.
    expect(removeBtn.className).toContain("bg-destructive");
    expect(removeBtn.dataset.variant).toBe("destructive");
  });

  it("renders a 'Cancel' button using the ghost variant (non-destructive)", () => {
    render(
      <ConfirmRemoveDatasourceDialog
        open={true}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(cancelBtn).toBeInTheDocument();
    // Button stamps data-variant per the variant prop.
    expect(cancelBtn.dataset.variant).toBe("ghost");
  });
});

describe("ConfirmRemoveDatasourceDialog — focus", () => {
  afterEach(() => {
    cleanup();
  });

  it("destructive Remove button has focus on open", async () => {
    render(
      <ConfirmRemoveDatasourceDialog
        open={true}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    // Wait for the portal to mount and onOpenAutoFocus to redirect focus
    // to the Remove button via the component's useEffect/ref.
    const removeBtn = await screen.findByRole("button", { name: "Remove" });
    await waitFor(() => {
      expect(document.activeElement).toBe(removeBtn);
    });
  });
});

describe("ConfirmRemoveDatasourceDialog — keyboard", () => {
  afterEach(() => {
    cleanup();
  });

  it("Escape triggers onCancel and does NOT trigger onConfirm", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmRemoveDatasourceDialog
        open={true}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    // Radix Dialog listens for Escape on the active element.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalled();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("ConfirmRemoveDatasourceDialog — click handlers", () => {
  afterEach(() => {
    cleanup();
  });

  it("clicking Cancel fires onCancel exactly once and does NOT fire onConfirm", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmRemoveDatasourceDialog
        open={true}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clicking Remove fires onConfirm exactly once", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmRemoveDatasourceDialog
        open={true}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
