/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { AuthRevokedState } from "../auth-revoked";

describe("AuthRevokedState", () => {
  afterEach(cleanup);

  it("renders headline, body, and a Reconnect action button", () => {
    render(<AuthRevokedState onReconnect={() => {}} />);
    expect(
      screen.getByText("Sign in again to view files"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your session for this datasource expired or was revoked.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /reconnect/i }),
    ).toBeInTheDocument();
  });

  it("uses role='alert' with aria-live='polite'", () => {
    render(<AuthRevokedState onReconnect={() => {}} />);
    const root = screen.getByTestId("file-explorer-state-auth-revoked");
    expect(root).toHaveAttribute("role", "alert");
    expect(root).toHaveAttribute("aria-live", "polite");
  });

  it("invokes onReconnect on click", () => {
    const onReconnect = vi.fn();
    render(<AuthRevokedState onReconnect={onReconnect} />);
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("renders amber iconography (KeyRound) aria-hidden", () => {
    render(<AuthRevokedState onReconnect={() => {}} />);
    const root = screen.getByTestId("file-explorer-state-auth-revoked");
    const svg = root.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.classList.toString()).toContain("text-amber-600");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });
});
