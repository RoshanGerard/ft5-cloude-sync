/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { EmptyState } from "../empty";

describe("EmptyState", () => {
  afterEach(cleanup);

  it("renders neutral headline, body, and no action button", () => {
    render(<EmptyState />);
    expect(screen.getByText("This folder is empty")).toBeInTheDocument();
    expect(
      screen.getByText(/Drop files on your datasource/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses role='status' with aria-live='polite'", () => {
    render(<EmptyState />);
    const root = screen.getByTestId("file-explorer-state-empty");
    expect(root).toHaveAttribute("role", "status");
    expect(root).toHaveAttribute("aria-live", "polite");
  });

  it("renders the FolderOpen icon in muted foreground, aria-hidden", () => {
    render(<EmptyState />);
    const root = screen.getByTestId("file-explorer-state-empty");
    const svg = root.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.classList.toString()).toContain("text-muted-foreground");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });
});
