/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { FieldRow, FieldRowWithCopy } from "../render-primitives.js";

// Render primitives consumed by the Details pane (Task 5.3/5.4) and
// Properties modal (Task 5.5/5.6). Both render a label/value pair; the
// copy variant adds a clipboard-write button with an accessible name.

describe("FieldRow", () => {
  afterEach(() => cleanup());

  it("renders the label and value", () => {
    render(<FieldRow label="Name" value="hero.png" />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("hero.png")).toBeInTheDocument();
  });

  it("applies `tabular-nums` when numeric=true", () => {
    render(<FieldRow label="Size" value="12 KB" numeric />);
    const valueEl = screen.getByText("12 KB");
    expect(valueEl.className).toMatch(/tabular-nums/);
  });

  it("does not apply `tabular-nums` when numeric is false/omitted", () => {
    render(<FieldRow label="Name" value="hero.png" />);
    const valueEl = screen.getByText("hero.png");
    expect(valueEl.className).not.toMatch(/tabular-nums/);
  });

  it("renders an em-dash placeholder when value is null", () => {
    render(<FieldRow label="Created" value={null} numeric />);
    // \u2014 is the em-dash chosen by view-modes/details-format for
    // missing numeric values; FieldRow reuses the same convention.
    expect(screen.getByText("\u2014")).toBeInTheDocument();
  });

  it("renders the label inside a muted-foreground element", () => {
    render(<FieldRow label="Path" value="/p/x" />);
    const labelEl = screen.getByText("Path");
    expect(labelEl.className).toMatch(/text-muted-foreground/);
  });
});

describe("FieldRowWithCopy", () => {
  beforeEach(() => {
    // jsdom does not provide navigator.clipboard by default; stub it so
    // the click handler's `navigator.clipboard.writeText` call resolves.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });
  afterEach(() => {
    cleanup();
    // Best-effort cleanup; the stub is re-set in every beforeEach so
    // leaving the descriptor in place across tests is fine.
  });

  it("renders the label and value like FieldRow", () => {
    render(
      <FieldRowWithCopy label="Path" value="/docs/report.pdf" rawValue="/docs/report.pdf" />,
    );
    expect(screen.getByText("Path")).toBeInTheDocument();
    expect(screen.getByText("/docs/report.pdf")).toBeInTheDocument();
  });

  it("exposes a copy button with an accessible name including the label", () => {
    render(
      <FieldRowWithCopy label="Path" value="/docs/report.pdf" rawValue="/docs/report.pdf" />,
    );
    const button = screen.getByRole("button", { name: /copy path/i });
    expect(button).toBeInTheDocument();
  });

  it("writes the raw value to the clipboard on click", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <FieldRowWithCopy
        label="Owner"
        value="alice@example.com"
        rawValue="alice@example.com"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /copy owner/i }));
    expect(writeText).toHaveBeenCalledWith("alice@example.com");
  });

  it("stringifies numeric raw values before writing to clipboard", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <FieldRowWithCopy label="Revisions" value="7" rawValue={7} numeric />,
    );
    fireEvent.click(screen.getByRole("button", { name: /copy revisions/i }));
    expect(writeText).toHaveBeenCalledWith("7");
  });

  it("does not call clipboard when rawValue is null (button is disabled)", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<FieldRowWithCopy label="Lock reason" value={null} rawValue={null} />);
    const button = screen.getByRole("button", { name: /copy lock reason/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("applies `tabular-nums` to the value span when numeric=true", () => {
    render(
      <FieldRowWithCopy label="Size" value="12 KB" rawValue="12 KB" numeric />,
    );
    const valueEl = screen.getByText("12 KB");
    expect(valueEl.className).toMatch(/tabular-nums/);
  });
});
