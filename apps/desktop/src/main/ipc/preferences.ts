// add-engine-rename-download §18.1-§18.2 — main-process handlers behind
// `window.api.preferences.*`.
//
// Background. The renderer's `downloads-store` (built in §20) is the
// durable owner of the default-downloads-folder preference — it
// persists to `localStorage["ft5.downloads.defaultFolder"]` per the
// existing `motion-store.ts` pattern (design.md V4 + spec.md "Downloads
// preferences resolve toPath from store + modifier keys"). This handler
// holds an in-memory mirror of the same value so callers outside the
// renderer-side store (the §22 first-download modal, future
// main-process flows) have a uniform `window.api.*` binding without
// each having to wire up its own contextBridge call into localStorage.
//
// No on-disk persistence here. The slot is reseeded each session by the
// renderer at startup (via `setDefaultDownloadsFolder` after reading its
// own localStorage). A renderer-only persistence model is what the spec
// calls for — the preload routes through main only to keep the surface
// uniform.

let currentDefaultDownloadsFolder: string | null = null;

export function handleSetDefaultDownloadsFolder(folder: string): void {
  currentDefaultDownloadsFolder = folder;
}

export function handleGetDefaultDownloadsFolder(): string | null {
  return currentDefaultDownloadsFolder;
}

// Post-archive bug-fix follow-up — `app.getPath("downloads")` exposure
// for the first-run modal (§21). The original task description deferred
// this and used the literal string `"~/Downloads/ft5"` as a placeholder;
// that placeholder fails the service-side `path.isAbsolute` check on
// every host, so every first-run download silently dropped server-side.
// Resolving the OS default here returns a real absolute path
// (`C:\Users\<u>\Downloads` on Windows, `/Users/<u>/Downloads` on macOS
// / Linux) which the renderer composes into `<dl>/ft5`.
//
// Dependency-injection shape mirrors the open-saved / show-saved
// handlers: the bound port is supplied by `registerIpcHandlers` so this
// module stays Electron-free for unit tests.
export interface OSDownloadsFolderProvider {
  getOSDefaultDownloadsFolder: () => string;
}

export function handleGetOSDefaultDownloadsFolder(
  deps: OSDownloadsFolderProvider,
): string {
  return deps.getOSDefaultDownloadsFolder();
}

/**
 * Test-only reset of the in-memory slot. Production callers must NOT
 * use this — the slot is intentionally session-scoped and is reseeded
 * by the renderer at startup.
 */
export function __resetPreferencesForTesting(): void {
  currentDefaultDownloadsFolder = null;
}
