/** @vitest-environment jsdom */
//
// Pre-paint motion bootstrap — asserts that the inline `<script>` that
// runs before React mounts reads `localStorage["ft5.motion"]` and applies
// `data-motion="safe"` on <html> synchronously. Mirrors the pattern used
// for the theme bootstrap script (features/theme/__tests__/no-fouc.test.tsx).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MOTION_BOOTSTRAP_SCRIPT } from "../motion-script";

const MOTION_STORAGE_KEY = "ft5.motion";

function runBootstrap(): void {
  new Function(MOTION_BOOTSTRAP_SCRIPT)();
}

describe("MOTION_BOOTSTRAP_SCRIPT (no-FOUC pre-paint)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-motion");
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-motion");
  });

  it("applies data-motion='safe' when preference is 'safe'", () => {
    localStorage.setItem(MOTION_STORAGE_KEY, "safe");
    runBootstrap();
    expect(document.documentElement.getAttribute("data-motion")).toBe("safe");
  });

  it("leaves <html> untouched (no data-motion) when no preference is stored (default = always-on)", () => {
    runBootstrap();
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
  });

  it("removes a stale data-motion when preference is absent (default)", () => {
    document.documentElement.setAttribute("data-motion", "safe");
    runBootstrap();
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
  });

  it("does NOT throw when localStorage access errors (silent swallow)", () => {
    // Override getItem to throw — simulates sandboxed / disabled storage.
    const original = window.Storage.prototype.getItem;
    window.Storage.prototype.getItem = () => {
      throw new Error("denied");
    };
    try {
      expect(() => runBootstrap()).not.toThrow();
    } finally {
      window.Storage.prototype.getItem = original;
    }
  });
});
