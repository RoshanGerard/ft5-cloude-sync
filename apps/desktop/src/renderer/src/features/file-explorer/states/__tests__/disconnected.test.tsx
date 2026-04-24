/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DisconnectedState } from "../disconnected";

describe("DisconnectedState", () => {
  afterEach(cleanup);

  it("renders headline, body, and a Retry action button", () => {
    render(<DisconnectedState onRetry={() => {}} />);
    expect(screen.getByText("Can't reach this datasource")).toBeInTheDocument();
    expect(
      screen.getByText("Check your network or try again in a moment."),
    ).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /retry/i });
    expect(btn).toBeInTheDocument();
    expect(btn.tagName).toBe("BUTTON");
  });

  it("uses role='alert' with aria-live='polite'", () => {
    render(<DisconnectedState onRetry={() => {}} />);
    const root = screen.getByTestId("file-explorer-state-disconnected");
    expect(root).toHaveAttribute("role", "alert");
    expect(root).toHaveAttribute("aria-live", "polite");
  });

  it("invokes onRetry when the button is clicked", () => {
    const onRetry = vi.fn();
    render(<DisconnectedState onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the CloudOff icon in amber and marks it aria-hidden", () => {
    render(<DisconnectedState onRetry={() => {}} />);
    const root = screen.getByTestId("file-explorer-state-disconnected");
    const svg = root.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.classList.toString()).toContain("text-amber-600");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });
});
