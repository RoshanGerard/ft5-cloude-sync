/** @vitest-environment jsdom */
// Task 4b.6 — "Glass on overlays only" visual decision (design.md Decision 11).
// Every Radix-Portaled overlay surface (Dialog overlay, Dialog content,
// DropdownMenu content, Tooltip content) must render with a Tailwind
// `backdrop-blur-*` utility so the UI feels like OS-native materials. Cards,
// toolbars, and other opaque surfaces stay flat (no blur), and this test
// spot-checks a Card to guard against accidental blur leak.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Radix Tooltip uses ResizeObserver (and DOMRect.fromRect) to track trigger
// dimensions; jsdom ships neither. Polyfill with a no-op shim before any test
// mounts so Tooltip renders without throwing.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = ResizeObserverStub;
  }
});

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Card } from "@/components/ui/card";

afterEach(() => cleanup());

describe("glass overlays — task 4b.6", () => {
  it("DialogOverlay has backdrop-blur-md class", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.className).toMatch(/\bbackdrop-blur-md\b/);
  });

  it("DialogContent has backdrop-blur-md and semi-transparent bg-background", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const content = document.querySelector('[data-slot="dialog-content"]');
    expect(content).not.toBeNull();
    expect(content!.className).toMatch(/\bbackdrop-blur-md\b/);
    // Light: bg-background/80, dark: dark:bg-background/70
    expect(content!.className).toMatch(/\bbg-background\/80\b/);
    expect(content!.className).toMatch(/\bdark:bg-background\/70\b/);
  });

  it("DropdownMenuContent has backdrop-blur-md class", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const content = document.querySelector(
      '[data-slot="dropdown-menu-content"]',
    );
    expect(content).not.toBeNull();
    expect(content!.className).toMatch(/\bbackdrop-blur-md\b/);
  });

  it("DropdownMenuContent uses a semi-transparent popover background", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const content = document.querySelector(
      '[data-slot="dropdown-menu-content"]',
    );
    expect(content).not.toBeNull();
    // Expect the semi-transparent popover form (lighter: 80%, darker: 70%)
    expect(content!.className).toMatch(/\bbg-popover\/80\b/);
    expect(content!.className).toMatch(/\bdark:bg-popover\/70\b/);
  });

  it("TooltipContent has backdrop-blur-sm class (lighter blur for smaller surface)", () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>hello</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const content = document.querySelector('[data-slot="tooltip-content"]');
    expect(content).not.toBeNull();
    expect(content!.className).toMatch(/\bbackdrop-blur-sm\b/);
  });

  it("Card primitive does NOT have any backdrop-blur-* class (glass is overlays-only)", () => {
    render(
      <Card data-testid="plain-card">
        <div>content</div>
      </Card>,
    );
    const card = screen.getByTestId("plain-card");
    expect(card.className).not.toMatch(/\bbackdrop-blur/);
  });
});
