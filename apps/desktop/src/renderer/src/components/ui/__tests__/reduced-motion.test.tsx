/** @vitest-environment jsdom */
// Task 4b.7 — Reduced-motion primitive-level verification.
//
// The accessibility guarantee for "OS-level prefers-reduced-motion" is that
// the Dialog overlay/content have zero running animation/transform when the
// user has asked for reduced motion. Tailwind v4 expresses this via the
// `motion-safe:` variant (only emits the rule when `prefers-reduced-motion`
// does NOT match `reduce`), which is the GREEN-path approach shadcn
// primitives take.
//
// Why a structural assertion (not getComputedStyle):
//   jsdom does not parse or apply external Tailwind stylesheets. Calling
//   `getComputedStyle(el).animationDuration` returns `""` regardless of
//   whether the `motion-safe:` gate is present, so that route passes
//   tautologically and proves nothing. Instead we read the element's
//   className string and assert every motion-producing utility
//   (animate-*, fade-*, zoom-*, slide-*) is prefixed with `motion-safe:`.
//
// The feature-level reduced-motion verification (dashboard pulse + skeleton
// shimmer actually stopping when the OS preference is set) is covered by
// task 5.4 at the DatasourceCard level — this test keeps the shadcn
// primitives honest.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

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

afterEach(() => cleanup());

// Every class token that drives motion: `animate-*`, `fade-*`, `zoom-*`,
// `slide-*` (but not the `animate-skeleton-shimmer` / `animate-sync-pulse`
// tokens — those are only emitted inside features/datasources, not on
// shadcn primitives). Matches with or without Tailwind variants prefixed.
const MOTION_CORE_RE =
  /\b(?:animate-(?:in|out|[a-z]+(?:-[0-9]+)?)|fade-(?:in|out)-[0-9]+|zoom-(?:in|out)-[0-9]+|slide-in-from-[a-z]+-[0-9]+|slide-out-to-[a-z]+-[0-9]+)\b/g;

/**
 * Split a class-list string into tokens and, for each motion-producing core,
 * return whether that token is gated behind `motion-safe:`.
 */
function assertMotionGated(className: string, label: string): void {
  const tokens = className.split(/\s+/).filter(Boolean);
  const ungated: string[] = [];
  for (const tok of tokens) {
    // Reset regex state; then check if the core is motion-producing.
    MOTION_CORE_RE.lastIndex = 0;
    const motionCore = MOTION_CORE_RE.exec(tok);
    if (!motionCore) continue;

    // Allow our two dashboard animation utilities through — they're scoped
    // to features/datasources components, not shadcn primitives, but if a
    // future primitive added one it should not require motion-safe since
    // the keyframes themselves are gated in globals.css.
    if (
      motionCore[0] === "animate-skeleton-shimmer" ||
      motionCore[0] === "animate-sync-pulse"
    ) {
      continue;
    }

    // Split variants. The token may look like:
    //   motion-safe:data-[state=open]:animate-in
    //   data-[state=open]:animate-in            (not gated — fail)
    //   animate-in                              (not gated — fail)
    //
    // "Variants" are the colon-delimited prefixes at bracket-depth 0.
    const variants = extractVariants(tok);
    if (!variants.includes("motion-safe")) {
      ungated.push(tok);
    }
  }
  expect(
    ungated,
    ungated.length
      ? `${label}: motion classes missing motion-safe: gate → ${ungated.join(", ")}`
      : "",
  ).toEqual([]);
}

function extractVariants(token: string): string[] {
  const variants: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    else if (ch === ":" && depth === 0) {
      variants.push(token.slice(start, i));
      start = i + 1;
    }
  }
  // Last segment is the core, not a variant — skip it.
  return variants;
}

describe("reduced-motion — shadcn primitive gates", () => {
  it("DialogOverlay motion classes are all prefixed with motion-safe:", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Test</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    assertMotionGated(overlay!.className, "DialogOverlay");
  });

  it("DialogContent motion classes are all prefixed with motion-safe:", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Test</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const content = document.querySelector('[data-slot="dialog-content"]');
    expect(content).not.toBeNull();
    assertMotionGated(content!.className, "DialogContent");
  });

  it("DropdownMenuContent motion classes are all prefixed with motion-safe:", () => {
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
    assertMotionGated(content!.className, "DropdownMenuContent");
  });

  it("extractVariants splits colon-delimited variants correctly", () => {
    expect(extractVariants("motion-safe:data-[state=open]:animate-in")).toEqual(
      ["motion-safe", "data-[state=open]"],
    );
    expect(extractVariants("animate-in")).toEqual([]);
    expect(extractVariants("data-[state=open]:animate-in")).toEqual([
      "data-[state=open]",
    ]);
  });

  it("assertMotionGated flags an ungated animate-in (regression control)", () => {
    // Prove the assertion actually has teeth: a class string containing a
    // bare animate-in should fail.
    expect(() =>
      assertMotionGated(
        "fixed inset-0 animate-in data-[state=open]:fade-in-0",
        "synthetic",
      ),
    ).toThrow(/motion-safe/);
  });

  it("assertMotionGated accepts fully-gated motion classes (regression control)", () => {
    expect(() =>
      assertMotionGated(
        "fixed inset-0 motion-safe:animate-in motion-safe:data-[state=open]:fade-in-0",
        "synthetic",
      ),
    ).not.toThrow();
  });
});
