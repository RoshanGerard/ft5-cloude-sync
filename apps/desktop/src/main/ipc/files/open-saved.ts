// add-engine-rename-download §18.3-§18.6 — main-process handlers behind
// `window.api.files.openSavedPath` and `window.api.files.showSavedInFolder`.
//
// Both handlers are thin proxies over Electron's `shell` module so the
// download-success toast's "Open" + "Show in folder" CTAs can reach the
// OS file manager. Spec ref: file-explorer/spec.md "Download success
// toast presents Open and Show-in-folder actions" (Open invokes
// `shell.openPath`; Show invokes `shell.showItemInFolder`).
//
// The Electron `shell` import lives in `ipc/index.ts` (where it is also
// already imported for the OAuth `openExternal` trampoline), so this
// module stays free of Electron and unit-testable under plain Node. The
// DI pattern matches `handlePickFilesToUpload`.

export interface FilesOpenSavedPathDeps {
  /** `electron.shell.openPath`. Resolves with empty string on success. */
  readonly openPath: (path: string) => Promise<string>;
}

export async function handleFilesOpenSavedPath(
  savedPath: string,
  deps: FilesOpenSavedPathDeps,
): Promise<void> {
  // Electron's `shell.openPath` resolves with a string: empty on success,
  // non-empty when the OS rejected the open request. The renderer has no
  // return surface (the toast has already dismissed by the time the OS
  // responds), so we discard the result. A future iteration could log to
  // the structured diagnostics channel.
  await deps.openPath(savedPath);
}

export interface FilesShowSavedInFolderDeps {
  /** `electron.shell.showItemInFolder`. Synchronous — no return value. */
  readonly showItemInFolder: (path: string) => void;
}

export function handleFilesShowSavedInFolder(
  savedPath: string,
  deps: FilesShowSavedInFolderDeps,
): void {
  deps.showItemInFolder(savedPath);
}
