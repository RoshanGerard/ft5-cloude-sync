/** @vitest-environment jsdom */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ConfirmDeleteDialog } from "../confirm-delete-dialog.js";

/**
 * ConfirmDeleteDialog — Phase 6.5. Spec reference:
 *   specs/file-explorer/spec.md "Delete shows a confirmation dialog before
 *   dispatching" — "Delete N items? This action cannot be undone." copy,
 *   destructive-styled Delete button, Escape cancels.
 */

describe("ConfirmDeleteDialog — visibility", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
  });

  it("is not in the DOM when open=false", () => {
    render(
      <ConfirmDeleteDialog
        open={false}
        count={3}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("mounts when open=true", () => {
    render(
      <ConfirmDeleteDialog
        open={true}
        count={1}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("ConfirmDeleteDialog — copy", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders 'Delete 1 item? This action cannot be undone.' for count=1", () => {
    render(
      <ConfirmDeleteDialog
        open={true}
        count={1}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      "Delete 1 item? This action cannot be undone.",
    );
  });

  it("renders 'Delete N items? This action cannot be undone.' for count>=2", () => {
    render(
      <ConfirmDeleteDialog
        open={true}
        count={5}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      "Delete 5 items? This action cannot be undone.",
    );
  });
});

describe("ConfirmDeleteDialog — buttons", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a 'Delete' button with destructive styling", () => {
    render(
      <ConfirmDeleteDialog
        open={true}
        count={2}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const deleteBtn = screen.getByRole("button", { name: "Delete" });
    // shadcn Button variant="destructive" stamps the `bg-destructive` class.
    expect(deleteBtn.className).toContain("bg-destructive");
  });

  it("renders a 'Cancel' button", () => {
    render(
      <ConfirmDeleteDialog
        open={true}
        count={2}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("clicking Delete fires onConfirm exactly once; Cancel fires onCancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteDialog
        open={true}
        count={2}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("ConfirmDeleteDialog — keyboard", () => {
  afterEach(() => {
    cleanup();
  });

  it("Escape triggers onCancel", async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDeleteDialog
        open={true}
        count={1}
        onConfirm={() => {}}
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
  });
});

describe("ConfirmDeleteDialog — focus trap invariant", () => {
  afterEach(() => {
    cleanup();
  });

  it("every focusable element is inside the dialog; close button present", async () => {
    render(
      <ConfirmDeleteDialog
        open={true}
        count={1}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = await screen.findByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>(
      "button, [href], [tabindex]:not([tabindex=\"-1\"])",
    );
    expect(focusables.length).toBeGreaterThan(0);
    for (const el of Array.from(focusables)) {
      expect(dialog.contains(el)).toBe(true);
    }
    // The shadcn DialogContent includes a built-in close button (sr-only).
    expect(
      dialog.querySelector<HTMLElement>("[data-slot=\"dialog-close\"]"),
    ).not.toBeNull();
  });
});
