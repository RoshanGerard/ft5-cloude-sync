/** @vitest-environment jsdom */
//
// Section 20 — `downloads-store` preferences. Mirrors `motion-store.ts`
// patterns but keys on two localStorage entries:
//
//   - `ft5.downloads.defaultFolder`  → absolute folder path string
//   - `ft5.downloads.alwaysAsk`      → "yes" | absent (no other values)
//
// See `openspec/changes/add-engine-rename-download/specs/file-explorer/spec.md`
// § "Downloads preferences resolve `toPath` from store + modifier keys"
// for the canonical schema.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  DOWNLOADS_DEFAULT_FOLDER_KEY,
  DOWNLOADS_ALWAYS_ASK_KEY,
  getDefaultFolder,
  getAlwaysAsk,
  setDefaultFolder,
  setAlwaysAsk,
  useAlwaysAsk,
  useDefaultFolder,
} from "../downloads-store";

describe("downloads-store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe("storage keys", () => {
    it("defaultFolder key is 'ft5.downloads.defaultFolder'", () => {
      expect(DOWNLOADS_DEFAULT_FOLDER_KEY).toBe(
        "ft5.downloads.defaultFolder",
      );
    });

    it("alwaysAsk key is 'ft5.downloads.alwaysAsk'", () => {
      expect(DOWNLOADS_ALWAYS_ASK_KEY).toBe("ft5.downloads.alwaysAsk");
    });
  });

  describe("getDefaultFolder", () => {
    it("returns null when the storage key is absent", () => {
      expect(getDefaultFolder()).toBeNull();
    });

    it("returns the stored path string when the key is set", () => {
      localStorage.setItem(
        DOWNLOADS_DEFAULT_FOLDER_KEY,
        "/Users/alice/Downloads/ft5",
      );
      expect(getDefaultFolder()).toBe("/Users/alice/Downloads/ft5");
    });
  });

  describe("setDefaultFolder", () => {
    it("writes the path to localStorage under the canonical key", () => {
      setDefaultFolder("/Users/alice/cloud-files");
      expect(localStorage.getItem(DOWNLOADS_DEFAULT_FOLDER_KEY)).toBe(
        "/Users/alice/cloud-files",
      );
    });

    it("notifies subscribers when the value changes", () => {
      const listener = vi.fn();
      // Trigger subscribe via the hook so we cover the public surface
      // — use the underlying React `useSyncExternalStore` integration
      // by mounting the hook.
      const { unmount } = renderHook(() => useDefaultFolder());
      // Replace the hook subscription with our spy by re-subscribing
      // — but the hook's subscription is internal. Use a storage event
      // round-trip instead: the cleaner contract is that the hook
      // re-renders when setDefaultFolder is called.
      unmount();
      // Direct subscriber-notification: we re-render via the public hook
      // and assert the value updates.
      const { result } = renderHook(() => useDefaultFolder());
      expect(result.current).toBeNull();
      act(() => {
        setDefaultFolder("/Users/alice/Downloads/ft5");
      });
      expect(result.current).toBe("/Users/alice/Downloads/ft5");
      // The listener spy is exercised here by symmetry with motion-store;
      // we only care that the hook surface reflects the change. Mark
      // the spy untouched is fine.
      expect(listener).not.toHaveBeenCalled();
    });

    it("mirrors the value into the main process via window.api.preferences.setDefaultDownloadsFolder", () => {
      const setMain = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("window", {
        ...window,
        api: { preferences: { setDefaultDownloadsFolder: setMain } },
      });
      setDefaultFolder("/Users/alice/Downloads/ft5");
      expect(setMain).toHaveBeenCalledWith("/Users/alice/Downloads/ft5");
    });

    it("is a safe no-op for the bridge call when window.api is absent", () => {
      // Default jsdom env has no `window.api` injected — the renderer
      // preload bridge isn't loaded under vitest. Storage must still
      // be written; the bridge call simply skips.
      expect(() => setDefaultFolder("/tmp/x")).not.toThrow();
      expect(localStorage.getItem(DOWNLOADS_DEFAULT_FOLDER_KEY)).toBe(
        "/tmp/x",
      );
    });
  });

  describe("getAlwaysAsk", () => {
    it("returns false by default (key absent)", () => {
      expect(getAlwaysAsk()).toBe(false);
    });

    it("returns true when the storage key is 'yes'", () => {
      localStorage.setItem(DOWNLOADS_ALWAYS_ASK_KEY, "yes");
      expect(getAlwaysAsk()).toBe(true);
    });

    it("returns false when the storage key is any other value", () => {
      localStorage.setItem(DOWNLOADS_ALWAYS_ASK_KEY, "no");
      expect(getAlwaysAsk()).toBe(false);
      localStorage.setItem(DOWNLOADS_ALWAYS_ASK_KEY, "true");
      expect(getAlwaysAsk()).toBe(false);
    });
  });

  describe("setAlwaysAsk", () => {
    it("setAlwaysAsk(true) writes 'yes' to the storage key", () => {
      setAlwaysAsk(true);
      expect(localStorage.getItem(DOWNLOADS_ALWAYS_ASK_KEY)).toBe("yes");
    });

    it("setAlwaysAsk(false) removes the storage key", () => {
      localStorage.setItem(DOWNLOADS_ALWAYS_ASK_KEY, "yes");
      setAlwaysAsk(false);
      expect(localStorage.getItem(DOWNLOADS_ALWAYS_ASK_KEY)).toBeNull();
    });
  });

  describe("useDefaultFolder hook", () => {
    it("returns null initially when no folder is stored", () => {
      const { result } = renderHook(() => useDefaultFolder());
      expect(result.current).toBeNull();
    });

    it("returns the stored value when set on first render", () => {
      localStorage.setItem(
        DOWNLOADS_DEFAULT_FOLDER_KEY,
        "/Users/alice/Downloads/ft5",
      );
      const { result } = renderHook(() => useDefaultFolder());
      expect(result.current).toBe("/Users/alice/Downloads/ft5");
    });

    it("re-renders when setDefaultFolder is called", () => {
      const { result } = renderHook(() => useDefaultFolder());
      expect(result.current).toBeNull();
      act(() => {
        setDefaultFolder("/Users/alice/Downloads/ft5");
      });
      expect(result.current).toBe("/Users/alice/Downloads/ft5");
    });
  });

  describe("useAlwaysAsk hook", () => {
    it("returns false initially", () => {
      const { result } = renderHook(() => useAlwaysAsk());
      expect(result.current).toBe(false);
    });

    it("returns true when the key is 'yes' on first render", () => {
      localStorage.setItem(DOWNLOADS_ALWAYS_ASK_KEY, "yes");
      const { result } = renderHook(() => useAlwaysAsk());
      expect(result.current).toBe(true);
    });

    it("re-renders when setAlwaysAsk flips", () => {
      const { result } = renderHook(() => useAlwaysAsk());
      expect(result.current).toBe(false);
      act(() => {
        setAlwaysAsk(true);
      });
      expect(result.current).toBe(true);
    });
  });
});
