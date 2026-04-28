// add-engine-rename-download §18.7-§18.8 — main-process handler behind
// `window.api.dialog.showSaveDialog`.
//
// Thin pass-through over Electron's `dialog.showSaveDialog` for the
// download orchestrator's Shift+Click and Always-ask branches
// (design.md V4 / file-explorer/spec.md "Shift+Click forces Save-as" +
// "Always-ask routing"). The renderer-supplied opts are forwarded
// verbatim; the BrowserWindow ref is attached at the `ipc/index.ts`
// registration site so this module stays free of Electron and is
// unit-testable under plain Node (mirrors `handlePickFilesToUpload`).

/**
 * Subset of Electron's `SaveDialogOptions` that the renderer actually
 * uses. Re-declared here (not imported from `electron`) so the handler
 * module can be unit-tested without the Electron runtime.
 */
export interface SaveDialogOptionsLike {
  readonly title?: string;
  readonly defaultPath?: string;
  readonly buttonLabel?: string;
  readonly filters?: ReadonlyArray<{
    readonly name: string;
    readonly extensions: readonly string[];
  }>;
}

/**
 * Subset of Electron's `SaveDialogReturnValue`. `filePath` is normalized
 * to `undefined` when the OS returns an empty string (historic quirk on
 * cancel) so the renderer's downstream `if (canceled || !filePath)`
 * branching stays consistent.
 */
export interface SaveDialogReturnValueLike {
  readonly canceled: boolean;
  readonly filePath?: string;
}

export interface DialogShowSaveDialogDeps {
  /**
   * `electron.dialog.showSaveDialog`, optionally bound to the app's
   * `BrowserWindow`. The bind happens at the registration site.
   */
  readonly showSaveDialog: (
    opts: SaveDialogOptionsLike,
  ) => Promise<{ canceled: boolean; filePath?: string }>;
}

export async function handleDialogShowSaveDialog(
  opts: SaveDialogOptionsLike,
  deps: DialogShowSaveDialogDeps,
): Promise<SaveDialogReturnValueLike> {
  const result = await deps.showSaveDialog(opts);
  // Normalize "" → undefined so renderer-side `!filePath` checks behave
  // consistently across platforms.
  const filePath =
    result.filePath !== undefined && result.filePath.length > 0
      ? result.filePath
      : undefined;
  return {
    canceled: result.canceled,
    ...(filePath !== undefined ? { filePath } : {}),
  };
}

// add-engine-rename-download §21 prerequisite — sibling pass-through
// behind `window.api.dialog.showOpenDialog`. Used by the first-run
// downloads modal's Browse button (§21) and the Settings dialog's
// Change… button (§22). Forwards renderer-supplied options verbatim
// (e.g. `{ properties: ['openDirectory', 'createDirectory'] }`); the
// BrowserWindow ref is attached at the `ipc/index.ts` registration
// site so this module stays free of Electron and is unit-testable
// under plain Node (mirrors `handleDialogShowSaveDialog`).

/**
 * Subset of Electron's `OpenDialogOptions` that the renderer actually
 * uses. Re-declared here (not imported from `electron`) so the handler
 * module can be unit-tested without the Electron runtime. Properties
 * is typed as a readonly string array — the renderer constrains the
 * vocabulary at the call site (the wire shape stays open here so
 * additive Electron values don't require a contract bump).
 */
export interface OpenDialogOptionsLike {
  readonly title?: string;
  readonly defaultPath?: string;
  readonly buttonLabel?: string;
  readonly properties?: readonly string[];
  readonly filters?: ReadonlyArray<{
    readonly name: string;
    readonly extensions: readonly string[];
  }>;
}

/**
 * Subset of Electron's `OpenDialogReturnValue`. `filePaths` is always
 * an array (Electron returns `[]` on cancel); the renderer's
 * downstream `if (canceled || filePaths.length === 0)` branching
 * stays consistent.
 */
export interface OpenDialogReturnValueLike {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export interface DialogShowOpenDialogDeps {
  /**
   * `electron.dialog.showOpenDialog`, optionally bound to the app's
   * `BrowserWindow`. The bind happens at the registration site.
   */
  readonly showOpenDialog: (
    opts: OpenDialogOptionsLike,
  ) => Promise<{ canceled: boolean; filePaths: readonly string[] }>;
}

export async function handleDialogShowOpenDialog(
  opts: OpenDialogOptionsLike,
  deps: DialogShowOpenDialogDeps,
): Promise<OpenDialogReturnValueLike> {
  const result = await deps.showOpenDialog(opts);
  return {
    canceled: result.canceled,
    filePaths: result.filePaths,
  };
}
