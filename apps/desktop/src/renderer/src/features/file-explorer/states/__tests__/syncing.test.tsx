/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { SyncingState } from "../syncing";

describe("SyncingState", () => {
  afterEach(cleanup);

  it("renders headline, body, spinner icon; no action button", () => {
    render(<SyncingState />);
    expect(screen.getByText("Indexing your files…")).toBeInTheDocument();
    expect(
      screen.getByText(/This happens once on first connect/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses role='status' with aria-live='polite'", () => {
    render(<SyncingState />);
    const root = screen.getByTestId("file-explorer-state-syncing");
    expect(root).toHaveAttribute("role", "status");
    expect(root).toHaveAttribute("aria-live", "polite");
  });

  it("renders an aria-hidden indicator icon with animate-sync-pulse in blue", () => {
    render(<SyncingState />);
    const root = screen.getByTestId("file-explorer-state-syncing");
    const svg = root.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.classList.toString()).toContain("animate-sync-pulse");
    expect(svg!.classList.toString()).toContain("text-blue-600");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders the progressLabel in text-blue-600 when supplied", () => {
    render(<SyncingState progressLabel="~1,240 files · 32%" />);
    const label = screen.getByText("~1,240 files · 32%");
    expect(label.classList.toString()).toContain("text-blue-600");
  });

  it("omits the progress label when the prop is absent", () => {
    render(<SyncingState />);
    expect(screen.queryByText(/files · /)).toBeNull();
  });
});
