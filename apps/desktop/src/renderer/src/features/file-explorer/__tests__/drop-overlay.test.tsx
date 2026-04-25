/** @vitest-environment jsdom */
//
// DropOverlay — unit tests for the stateless overlay component.
// The overlay is pure presentation; the DropZone's tests cover the
// activation / drop-handling behaviour. Here we only assert that each
// variant renders the copy, icon, and a11y attributes the design.md
// "Visual direction" section specifies.

import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DropOverlay } from "../drop-overlay.js";

afterEach(() => {
  cleanup();
});

describe("DropOverlay — active variant", () => {
  it('renders "Drop to upload here" + "→ <targetDir>" with role=status + aria-live=polite', () => {
    render(<DropOverlay kind="active" targetDir="/projects/2026" />);
    const overlay = screen.getByTestId("drop-overlay-active");
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveAttribute("role", "status");
    expect(overlay).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Drop to upload here")).toBeInTheDocument();
    expect(screen.getByText("→ /projects/2026")).toBeInTheDocument();
  });

  it("uses the amber palette via border-amber-600 + bg-amber-600/8", () => {
    render(<DropOverlay kind="active" targetDir="/" />);
    const overlay = screen.getByTestId("drop-overlay-active");
    expect(overlay.className).toContain("border-amber-600");
    expect(overlay.className).toContain("bg-amber-600/8");
  });

  it("has pointer-events-none so drag events can bubble through", () => {
    render(<DropOverlay kind="active" targetDir="/" />);
    const overlay = screen.getByTestId("drop-overlay-active");
    expect(overlay.className).toContain("pointer-events-none");
  });
});

describe("DropOverlay — blocked variant", () => {
  it('renders "Can\'t upload right now" with the disconnected-specific body', () => {
    render(<DropOverlay kind="blocked" blockedReason="disconnected" />);
    const overlay = screen.getByTestId("drop-overlay-blocked");
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveAttribute("role", "status");
    expect(overlay).toHaveAttribute("data-blocked-reason", "disconnected");
    expect(screen.getByText("Can't upload right now")).toBeInTheDocument();
    expect(
      screen.getByText("This datasource is disconnected"),
    ).toBeInTheDocument();
  });

  it("renders the auth-revoked copy", () => {
    render(<DropOverlay kind="blocked" blockedReason="auth-revoked" />);
    expect(
      screen.getByText("This datasource needs you to sign in again"),
    ).toBeInTheDocument();
  });

  it("renders the syncing copy and uses animate-sync-pulse on the icon (NOT animate-spin)", () => {
    const { container } = render(
      <DropOverlay kind="blocked" blockedReason="syncing" />,
    );
    expect(
      screen.getByText(
        "This datasource is still indexing — try again in a moment",
      ),
    ).toBeInTheDocument();
    // The icon must carry `animate-sync-pulse`, not `animate-spin`, per the
    // project's motion budget rule.
    const animated = container.querySelector(".animate-sync-pulse");
    expect(animated).not.toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("uses neutral palette (border-muted-foreground, no amber tint)", () => {
    render(<DropOverlay kind="blocked" blockedReason="disconnected" />);
    const overlay = screen.getByTestId("drop-overlay-blocked");
    expect(overlay.className).toContain("border-muted-foreground");
    expect(overlay.className).not.toContain("bg-amber-600");
  });
});
