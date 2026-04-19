/** @vitest-environment jsdom */
//
// Motion preference store — mirrors the shape of theme-store.ts but keys on
// `localStorage["ft5.motion"]` and drives the `data-motion` attribute on
// <html>. Default preference is "always-on" (custom animations always run,
// regardless of OS `prefers-reduced-motion`). The user can opt into "safe" —
// in which case the attribute is written and the CSS override in globals.css
// disables our custom animations when the OS also signals reduce-motion.
//
// See design.md "App-level preferences" + Decision 10 (motion).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyEffectivePreference,
  getStoredPreference,
  MOTION_STORAGE_KEY,
  setPreference,
  subscribe,
} from "../motion-store";

describe("motion-store", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-motion");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.removeAttribute("data-motion");
  });

  describe("MOTION_STORAGE_KEY", () => {
    it("is the canonical 'ft5.motion' key", () => {
      expect(MOTION_STORAGE_KEY).toBe("ft5.motion");
    });
  });

  describe("getStoredPreference", () => {
    it("defaults to 'always-on' when no storage key is present", () => {
      expect(getStoredPreference()).toBe("always-on");
    });

    it("returns 'safe' when the storage key is 'safe'", () => {
      localStorage.setItem(MOTION_STORAGE_KEY, "safe");
      expect(getStoredPreference()).toBe("safe");
    });

    it("treats any other stored value as 'always-on' (default)", () => {
      localStorage.setItem(MOTION_STORAGE_KEY, "garbage");
      expect(getStoredPreference()).toBe("always-on");
    });

    it("returns 'always-on' explicitly when 'always-on' is stored", () => {
      localStorage.setItem(MOTION_STORAGE_KEY, "always-on");
      expect(getStoredPreference()).toBe("always-on");
    });
  });

  describe("setPreference", () => {
    it("setPreference('safe') writes the storage key and sets data-motion='safe'", () => {
      setPreference("safe");
      expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("safe");
      expect(document.documentElement.getAttribute("data-motion")).toBe("safe");
    });

    it("setPreference('always-on') removes the storage key and the attribute", () => {
      // Start in the opposite state.
      localStorage.setItem(MOTION_STORAGE_KEY, "safe");
      document.documentElement.setAttribute("data-motion", "safe");

      setPreference("always-on");
      expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBeNull();
      expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
    });
  });

  describe("applyEffectivePreference", () => {
    it("applies data-motion='safe' on <html> when preference is 'safe'", () => {
      localStorage.setItem(MOTION_STORAGE_KEY, "safe");
      applyEffectivePreference();
      expect(document.documentElement.getAttribute("data-motion")).toBe("safe");
    });

    it("removes data-motion when preference is 'always-on' (default)", () => {
      document.documentElement.setAttribute("data-motion", "safe");
      // No storage key → default 'always-on'.
      applyEffectivePreference();
      expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
    });
  });

  describe("subscribe", () => {
    it("notifies subscribers when setPreference is called", () => {
      const listener = vi.fn();
      const unsubscribe = subscribe(listener);
      setPreference("safe");
      expect(listener).toHaveBeenCalled();
      unsubscribe();
    });

    it("stops notifying after the returned unsubscribe is invoked", () => {
      const listener = vi.fn();
      const unsubscribe = subscribe(listener);
      unsubscribe();
      setPreference("safe");
      expect(listener).not.toHaveBeenCalled();
    });

    it("notifies on cross-tab storage events for the motion key", () => {
      const listener = vi.fn();
      const unsubscribe = subscribe(listener);

      const evt = new StorageEvent("storage", {
        key: MOTION_STORAGE_KEY,
        newValue: "safe",
        oldValue: null,
        storageArea: window.localStorage,
      });
      window.dispatchEvent(evt);

      expect(listener).toHaveBeenCalled();
      unsubscribe();
    });

    it("ignores storage events for unrelated keys", () => {
      const listener = vi.fn();
      const unsubscribe = subscribe(listener);

      const evt = new StorageEvent("storage", {
        key: "some.other.key",
        newValue: "x",
        storageArea: window.localStorage,
      });
      window.dispatchEvent(evt);

      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });
  });
});
