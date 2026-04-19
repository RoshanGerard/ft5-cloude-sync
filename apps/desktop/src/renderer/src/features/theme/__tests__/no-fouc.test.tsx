/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { THEME_BOOTSTRAP_SCRIPT } from "../theme-script";

const THEME_STORAGE_KEY = "ft5.theme";

/**
 * Evaluate the pre-paint bootstrap script against the current jsdom globals.
 * This simulates the inline `<script>` in `<head>` running before React
 * mounts. `new Function()` gives the script access to the surrounding
 * `window` / `document` / `localStorage` (same as an inline tag would) but
 * runs it in an isolated function scope so the IIFE's locals don't leak.
 */
function runBootstrap(): void {
  new Function(THEME_BOOTSTRAP_SCRIPT)();
}

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe("THEME_BOOTSTRAP_SCRIPT (no-FOUC pre-paint)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-theme");
  });

  it("applies `.dark` (and no data-theme) when preference is 'dark'", () => {
    // Simulate stale serene-blue attribute from a prior session — the
    // bootstrap script must strip it (review-round-3, Task 6b: every branch
    // resets both the class and the attribute).
    document.documentElement.setAttribute("data-theme", "serene-blue");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    stubMatchMedia(false);
    runBootstrap();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("does NOT apply `.dark` (and no data-theme) when preference is 'light'", () => {
    document.documentElement.classList.add("dark"); // simulate stale state
    document.documentElement.setAttribute("data-theme", "serene-blue");
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    stubMatchMedia(true); // even if OS prefers dark, explicit light wins
    runBootstrap();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("falls back to matchMedia when no preference is stored (dark OS)", () => {
    stubMatchMedia(true);
    runBootstrap();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("falls back to matchMedia when no preference is stored (light OS)", () => {
    document.documentElement.classList.add("dark"); // simulate stale state
    stubMatchMedia(false);
    runBootstrap();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("applies data-theme='serene-blue' (and removes `.dark`) when preference is 'serene-blue'", () => {
    // Review-round-3, Task 6b: Serene Blue is an explicit light-mode
    // alternative — the pre-paint script must set the attribute and
    // strip any stale `.dark` class before React mounts.
    document.documentElement.classList.add("dark"); // simulate stale state
    localStorage.setItem(THEME_STORAGE_KEY, "serene-blue");
    stubMatchMedia(true); // even if OS prefers dark, explicit serene-blue wins
    runBootstrap();
    expect(document.documentElement.getAttribute("data-theme")).toBe("serene-blue");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("serene-blue preference wins over OS light preference too (explicit override)", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "serene-blue");
    stubMatchMedia(false);
    runBootstrap();
    expect(document.documentElement.getAttribute("data-theme")).toBe("serene-blue");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
