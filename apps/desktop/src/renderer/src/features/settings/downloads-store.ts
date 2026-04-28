"use client";

import { useSyncExternalStore } from "react";

/**
 * Downloads preferences store — the renderer-side cache for the user's
 * default downloads folder and the "always ask" toggle. Modelled on
 * `motion-store.ts`, but keys two distinct localStorage entries:
 *
 *   - `ft5.downloads.defaultFolder` — absolute folder path string. Absent
 *     until the user commits a folder via the first-run modal or the
 *     Settings dialog.
 *   - `ft5.downloads.alwaysAsk` — only ever set to `"yes"`. Absent means
 *     the toggle is off (default).
 *
 * Reads come purely from localStorage. `setDefaultFolder` ALSO mirrors
 * the value into the main process's in-memory preferences slot via
 * `window.api.preferences.setDefaultDownloadsFolder` so cross-process
 * consumers (e.g. the on-launch hydrate path, future main-process
 * download fall-through logic) can resolve the value without round-
 * tripping back to the renderer. The main-process call is fire-and-
 * forget; storage is the source of truth for the renderer.
 *
 * See `openspec/changes/add-engine-rename-download/specs/file-explorer/spec.md`
 * § "Downloads preferences resolve `toPath` from store + modifier keys"
 * for the canonical schema. The companion main-process slot is in
 * `apps/desktop/src/main/ipc/preferences.ts`.
 */

export const DOWNLOADS_DEFAULT_FOLDER_KEY = "ft5.downloads.defaultFolder";
export const DOWNLOADS_ALWAYS_ASK_KEY = "ft5.downloads.alwaysAsk";

const listeners = new Set<() => void>();

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function notify(): void {
  for (const l of listeners) l();
}

export function getDefaultFolder(): string | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(DOWNLOADS_DEFAULT_FOLDER_KEY);
    return raw === null || raw === "" ? null : raw;
  } catch {
    return null;
  }
}

export function setDefaultFolder(folder: string): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(DOWNLOADS_DEFAULT_FOLDER_KEY, folder);
  } catch {
    // Storage quota / sandbox — fall through to the bridge so the main
    // process at least has the new value.
  }

  // Mirror into the main-process preferences slot. The bridge is fire-
  // and-forget; renderer reads continue to use localStorage. Defensive
  // access mirrors `context-menu.tsx`'s clipboard-bridge pattern: tests
  // and non-Electron environments don't always inject `window.api`.
  const bridge = (
    globalThis as unknown as {
      window?: {
        api?: {
          preferences?: {
            setDefaultDownloadsFolder?: (folder: string) => Promise<void>;
          };
        };
      };
    }
  ).window?.api?.preferences?.setDefaultDownloadsFolder;
  if (typeof bridge === "function") {
    void bridge(folder);
  }

  notify();
}

export function getAlwaysAsk(): boolean {
  if (!isBrowser()) return false;
  try {
    return (
      window.localStorage.getItem(DOWNLOADS_ALWAYS_ASK_KEY) === "yes"
    );
  } catch {
    return false;
  }
}

export function setAlwaysAsk(value: boolean): void {
  if (!isBrowser()) return;
  try {
    if (value) {
      window.localStorage.setItem(DOWNLOADS_ALWAYS_ASK_KEY, "yes");
    } else {
      // Absent = off, matching the schema in spec.md.
      window.localStorage.removeItem(DOWNLOADS_ALWAYS_ASK_KEY);
    }
  } catch {
    // Storage quota / sandbox — still notify so React state stays in
    // sync with whatever ended up in storage.
  }
  notify();
}

function subscribeForKey(
  watchKey: string,
  listener: () => void,
): () => void {
  listeners.add(listener);

  const storageHandler = (e: StorageEvent) => {
    if (e.key === watchKey || e.key === null) {
      listener();
    }
  };

  if (isBrowser()) {
    window.addEventListener("storage", storageHandler);
  }

  return () => {
    listeners.delete(listener);
    if (isBrowser()) {
      window.removeEventListener("storage", storageHandler);
    }
  };
}

export function subscribeDefaultFolder(listener: () => void): () => void {
  return subscribeForKey(DOWNLOADS_DEFAULT_FOLDER_KEY, listener);
}

export function subscribeAlwaysAsk(listener: () => void): () => void {
  return subscribeForKey(DOWNLOADS_ALWAYS_ASK_KEY, listener);
}

export function useDefaultFolder(): string | null {
  return useSyncExternalStore(
    subscribeDefaultFolder,
    () => getDefaultFolder(),
    () => null,
  );
}

export function useAlwaysAsk(): boolean {
  return useSyncExternalStore(
    subscribeAlwaysAsk,
    () => getAlwaysAsk(),
    () => false,
  );
}
