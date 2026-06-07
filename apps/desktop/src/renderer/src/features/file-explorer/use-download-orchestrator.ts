"use client";

//
// add-engine-rename-download §23 — renderer download orchestrator.
//
// `useDownloadOrchestrator` is the file-explorer's dispatcher for
// `window.api.files.download`. It owns the renderer-side `toPath`
// resolution: combining the persisted `downloads-store` (default folder
// + Always-ask toggle) with the click-time `shiftKey` modifier, then
// optionally opening Electron's Save-as dialog before dispatching.
//
// First-ever-download path: when `getDefaultFolder()` returns null the
// orchestrator does NOT dispatch. Instead it stashes the call args in a
// ref and flips `modalOpen=true`; the caller renders
// `<FirstDownloadModal {...modalProps} />` which collects the folder,
// persists it via §20's `setDefaultFolder`, and invokes the modal's
// `onCommit(folder)` callback. The orchestrator's `onModalCommit`
// re-runs the deferred dispatch against the now-set folder.
//
// Per design.md Decision 8, `dispatchDownload` returns the
// `FilesDownloadResponse` envelope on dispatch (NOT a `downloadJobId`,
// since the contract carries only `{ savedPath, bytes }`); the toast
// helper (§24) is decoupled and binds to events independently. When the
// download is queued by the modal OR when the user cancels the
// Save-as dialog, `dispatchDownload` resolves to `null` (no envelope).
//
// Mirrors the `createUploadOrchestrator` collaborator-injection pattern:
// every `window.api.*` touchpoint can be supplied via the `api` option
// so unit tests never depend on the Electron preload bridge.

import { useCallback, useRef, useState } from "react";

import type {
  FileEntry,
  FilesDownloadRequest,
  FilesDownloadResponse,
} from "@ft5/ipc-contracts";

import {
  getAlwaysAsk,
  getDefaultFolder,
} from "../settings/downloads-store";
import type {
  DownloadConflictChoice,
  DownloadConflictPolicy,
  DownloadConflictPrompt,
} from "./store";

export interface SaveDialogResult {
  readonly canceled: boolean;
  readonly filePath?: string;
}

export interface SaveDialogOptions {
  readonly title?: string;
  readonly defaultPath?: string;
  readonly buttonLabel?: string;
  readonly filters?: ReadonlyArray<{
    readonly name: string;
    readonly extensions: readonly string[];
  }>;
}

export interface DownloadOrchestratorApi {
  readonly download: (
    req: FilesDownloadRequest,
  ) => Promise<FilesDownloadResponse>;
  readonly showSaveDialog: (
    opts: SaveDialogOptions,
  ) => Promise<SaveDialogResult>;
}

export interface UseDownloadOrchestratorOptions {
  /**
   * Optional collaborator override. Tests inject this to avoid touching
   * `window.api`; production callers omit it and the hook falls back to
   * the preload bridge.
   */
  readonly api?: DownloadOrchestratorApi;
  /**
   * Optional download-conflict prompt port (add-download-overwrite-confirm
   * §5). When supplied, the orchestrator's dispatch loop intercepts a
   * `tag: "conflict"` envelope from the service-side gate and invokes
   * the prompt with `(existingPath, existingSize, existingModifiedAt)`.
   * The user's choice (`"overwrite" | "keep-both"`) drives a re-dispatch
   * with the matching `conflictPolicy`; `"cancel"` aborts cleanly and
   * `dispatchDownload` resolves to `null` (so the caller's catch chain
   * doesn't fire).
   *
   * When omitted, conflict envelopes pass straight through to the
   * caller — preserves the pre-§5 behaviour for tests / harnesses that
   * don't wire a dialog. `<FileExplorer>` reads the registered prompt
   * off the explorer store (via `getDownloadConflictPrompt()`) and
   * passes it here on every render so the orchestrator stays decoupled
   * from the store.
   */
  readonly downloadConflictPrompt?: DownloadConflictPrompt | null;
}

interface PendingDownload {
  readonly entry: FileEntry;
  readonly datasourceId: string;
  readonly shiftKey: boolean;
}

export interface UseDownloadOrchestratorResult {
  /**
   * Dispatch a download for `entry` on `datasourceId`. Resolves to:
   *   - the `FilesDownloadResponse` envelope on dispatch
   *   - `null` if the user cancelled the save-as dialog
   *   - `null` if the download was queued (no default folder yet)
   */
  dispatchDownload(
    entry: FileEntry,
    modifierKeys: { shiftKey: boolean },
    datasourceId: string,
  ): Promise<FilesDownloadResponse | null>;
  /** Whether the first-run modal should be open. Drive `<FirstDownloadModal>` from this. */
  modalOpen: boolean;
  /**
   * Modal's `onCommit(folder)` callback — wire to
   * `<FirstDownloadModal onCommit={onModalCommit} />`. The modal has
   * already persisted the folder via `setDefaultFolder` before invoking
   * this; this hook flushes the deferred dispatch against it.
   */
  onModalCommit(folder: string): void;
}

// --- Production fallbacks --------------------------------------------

function resolveApi(
  injected: DownloadOrchestratorApi | undefined,
): DownloadOrchestratorApi {
  if (injected) return injected;
  // Production fallback — pull from the preload bridge. Lookup is LAZY:
  // we resolve the bridge fields at the moment `download` /
  // `showSaveDialog` are actually invoked so that mounting the hook in
  // a test harness without those bridge fields doesn't throw at hook-
  // call time. Throwing at the call site keeps the failure mode
  // diagnosable while making the hook safe to mount everywhere.
  function resolveBridge(): {
    download?: (
      req: FilesDownloadRequest,
    ) => Promise<FilesDownloadResponse>;
    showSaveDialog?: (
      opts: SaveDialogOptions,
    ) => Promise<SaveDialogResult>;
  } {
    const bridge = (
      globalThis as unknown as {
        window?: {
          api?: {
            files?: {
              download?: (
                req: FilesDownloadRequest,
              ) => Promise<FilesDownloadResponse>;
            };
            dialog?: {
              showSaveDialog?: (
                opts: SaveDialogOptions,
              ) => Promise<SaveDialogResult>;
            };
          };
        };
      }
    ).window?.api;
    return {
      download: bridge?.files?.download,
      showSaveDialog: bridge?.dialog?.showSaveDialog,
    };
  }
  return {
    download: async (req) => {
      const fn = resolveBridge().download;
      if (typeof fn !== "function") {
        throw new Error(
          "useDownloadOrchestrator: window.api.files.download is unavailable",
        );
      }
      return fn(req);
    },
    showSaveDialog: async (opts) => {
      const fn = resolveBridge().showSaveDialog;
      if (typeof fn !== "function") {
        throw new Error(
          "useDownloadOrchestrator: window.api.dialog.showSaveDialog is unavailable",
        );
      }
      return fn(opts);
    },
  };
}

// --- Filename sanitization ------------------------------------------

// Windows-invalid filename characters (`< > : " / \ | ? *` plus C0 control
// chars `\x00-\x1F`). POSIX is more permissive (only `/` and `\0` are
// reserved), but the orchestrator runs in Electron and may target a
// Windows host, so the stricter superset is used uniformly. The source
// `path` / `handle` sent to the engine is NOT sanitized — Drive can host
// a file named `Acme: Test file` and the strategy correctly references it
// by handle. Only the local-filesystem `toPath` needs the cleanup.
const WINDOWS_INVALID_CHAR_RE = /[<>:"/\\|?*\x00-\x1F]/g;

// Windows reserved device names (case-insensitive, matched against the
// basename without extension). Pre-pending `_` keeps the sanitized name
// distinct from the device while preserving recognisability.
const WINDOWS_RESERVED_DEVICES = new Set<string>([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * Replace Windows-invalid chars (`< > : " / \ | ? *` + control chars) with
 * `_`, trim leading/trailing whitespace + dots (Windows refuses files that
 * end in `.` or space), and prefix `_` to Windows reserved device names
 * (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`).
 *
 * Returns `_unnamed_` when sanitization removes every character (e.g. the
 * input was `" "` or only invalid chars) so the caller never produces an
 * empty filename.
 *
 * Source `path` on the engine side is NOT touched — Drive can carry
 * names with colons / slashes fine via `handle`. This is purely a
 * local-filesystem concern at the renderer's `toPath` boundary.
 *
 * Exported for direct unit testing.
 */
export function sanitizeFilenameForOS(name: string): string {
  // 1. Replace invalid chars with `_`.
  let sanitized = name.replace(WINDOWS_INVALID_CHAR_RE, "_");
  // 2. Trim leading/trailing whitespace + trailing dots. Windows refuses
  //    `foo.` and `  foo  ` — Explorer silently strips the trailing dot
  //    on creation, but `fs.writeFile` raises EINVAL on some flows.
  sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, "");
  // 3. Empty after sanitization → fallback. Avoids producing a path that
  //    ends in just the folder separator.
  if (sanitized === "") return "_unnamed_";
  // 4. Reserved-device-name guard. Compare the basename (the part before
  //    the FIRST dot) case-insensitively. `CON.txt` → reserved → `_CON.txt`.
  //    `CON.tar.gz` also flags as reserved because the "CON" prefix
  //    matches regardless of how many trailing-dot segments follow.
  //    Uses `indexOf` (not `lastIndexOf`) for two reasons: (a) it's the
  //    semantically-correct anchor for compound extensions like `.tar.gz`,
  //    and (b) `lastIndexOf(".")` is forbidden by the renderer-side
  //    extension-parsing guardrail (`scripts/no-extension-parsing.test.ts`).
  const dotIdx = sanitized.indexOf(".");
  const stem = dotIdx > 0 ? sanitized.slice(0, dotIdx) : sanitized;
  if (WINDOWS_RESERVED_DEVICES.has(stem.toUpperCase())) {
    return `_${sanitized}`;
  }
  return sanitized;
}

// --- Path joining ----------------------------------------------------

/**
 * Compose `<folder>/<filename>` host-aware. The folder is supplied by
 * either Electron's directory picker (host-native separator — `\` on
 * Windows, `/` elsewhere) or by `app.getPath("downloads")` (also host-
 * native). The renderer doesn't have `node:path`, so we derive the
 * separator from the folder string itself: if the folder contains a
 * backslash we use `\`, otherwise `/`.
 *
 * The filename is run through `sanitizeFilenameForOS` BEFORE concatenation
 * so vendor-side characters that are valid on Drive (colon, slash, etc.)
 * but invalid on Windows are scrubbed to `_` before they cross IPC.
 *
 * Bug-fix history: the original implementation hard-coded `/` between
 * folder and filename. On Windows that produced `C:\Users\...\ft5/file`,
 * which the service's `path.normalize(input) === input` validator
 * (the post-archive defence-in-depth check from §6.5) rejects as
 * "contains traversal" because Windows' `path.normalize` rewrites the
 * mixed `/` to `\`. Every download silently failed at validation and
 * the renderer voided the response, so the user saw "nothing happens".
 *
 * Exported so the first-download-modal can use the same logic when it
 * appends `ft5` to the OS-resolved downloads folder.
 */
export function joinFolderAndName(folder: string, filename: string): string {
  const stripped = folder.replace(/[/\\]+$/, "");
  const trimmedName = filename.replace(/^[/\\]+/, "");
  const safeName = sanitizeFilenameForOS(trimmedName);
  // Determine the separator from the folder's existing separators.
  // Windows-style absolute paths always contain `\`; POSIX paths never
  // do. If the folder is just a drive letter (`C:`) with no separator
  // yet, fall back to `\` to match Windows convention.
  const useBackslash =
    stripped.includes("\\") || /^[A-Za-z]:$/.test(stripped);
  const sep = useBackslash ? "\\" : "/";
  return stripped + sep + safeName;
}

// --- Hook ------------------------------------------------------------

export function useDownloadOrchestrator(
  options?: UseDownloadOrchestratorOptions,
): UseDownloadOrchestratorResult {
  const api = resolveApi(options?.api);
  const pendingRef = useRef<PendingDownload | null>(null);
  const [modalOpen, setModalOpen] = useState<boolean>(false);

  // Pin the latest conflict-prompt option in a ref so the dispatch
  // closure (memoised on `api`) always reads the current registration
  // without forcing a `useCallback` rebuild on every prompt swap.
  // `<FileExplorer>` may pass a fresh closure on every render via the
  // store's `getDownloadConflictPrompt()` lookup; pinning prevents
  // dispatch identity from churning unnecessarily.
  const conflictPromptRef = useRef<DownloadConflictPrompt | null>(
    options?.downloadConflictPrompt ?? null,
  );
  conflictPromptRef.current = options?.downloadConflictPrompt ?? null;

  const dispatchAgainstFolder = useCallback(
    async (
      entry: FileEntry,
      datasourceId: string,
      shiftKey: boolean,
      defaultFolder: string,
    ): Promise<FilesDownloadResponse | null> => {
      const alwaysAsk = getAlwaysAsk();
      const wantSaveDialog = shiftKey || alwaysAsk;

      let toPath: string;
      if (wantSaveDialog) {
        const result = await api.showSaveDialog({
          defaultPath: joinFolderAndName(defaultFolder, entry.name),
        });
        if (result.canceled || !result.filePath) {
          return null;
        }
        toPath = result.filePath;
      } else {
        toPath = joinFolderAndName(defaultFolder, entry.name);
      }

      // add-download-overwrite-confirm §5 — conflict re-prompt loop.
      //
      // Initial dispatch always carries `conflictPolicy: "fail"` so the
      // service-side gate surfaces a `tag: "conflict"` envelope when
      // the destination already exists (§5.1, spec scenario "Initial
      // download dispatch carries `conflictPolicy: 'fail'` by default").
      // On conflict + a registered prompt, invoke the prompt with the
      // envelope's hint metadata and re-dispatch with the user's choice;
      // `"cancel"` resolves to `null` (no second dispatch, no caller
      // catch chain — symmetric with the save-dialog cancel sentinel).
      //
      // The loop is bounded at 5 attempts (matches `store.rename`'s
      // defensive bound) so a misbehaving prompt that never returns
      // `"cancel"` and a backend that always returns `tag: "conflict"`
      // can't spin forever. In practice the backend either truncates
      // (overwrite) or finds a free suffix (keep-both) on the second
      // attempt; one extra slot is paranoia.
      let policy: DownloadConflictPolicy = "fail";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await api.download({
          datasourceId,
          path: entry.path,
          toPath,
          conflictPolicy: policy,
        });
        if (response.ok) return response;
        if (response.error.tag !== "conflict") return response;
        const prompt = conflictPromptRef.current;
        if (prompt === null) return response;
        const choice: DownloadConflictChoice = await prompt(
          response.error.existingPath ?? toPath,
          response.error.existingSize,
          response.error.existingModifiedAt,
        );
        if (choice === "cancel") return null;
        policy = choice;
      }
      // Loop bound exhausted (extraordinary). Surface as a synthetic
      // failure envelope so the caller's existing catch / error toast
      // chain has something diagnostic to render.
      return {
        ok: false,
        error: {
          tag: "other",
          message: "download conflict retry limit exceeded",
          retryable: false,
        },
      };
    },
    [api],
  );

  const dispatchDownload = useCallback(
    async (
      entry: FileEntry,
      modifierKeys: { shiftKey: boolean },
      datasourceId: string,
    ): Promise<FilesDownloadResponse | null> => {
      const folder = getDefaultFolder();
      if (folder === null) {
        // First-ever download: stash + open the modal. The dispatch will
        // fire from `onModalCommit` once the user picks a folder.
        pendingRef.current = {
          entry,
          datasourceId,
          shiftKey: modifierKeys.shiftKey,
        };
        setModalOpen(true);
        return null;
      }
      return dispatchAgainstFolder(
        entry,
        datasourceId,
        modifierKeys.shiftKey,
        folder,
      );
    },
    [dispatchAgainstFolder],
  );

  const onModalCommit = useCallback(
    (folder: string) => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      setModalOpen(false);
      if (pending === null) return;
      // Flush the deferred dispatch. The modal has already persisted the
      // folder via `setDefaultFolder` before invoking this callback, so
      // the next `getDefaultFolder()` call inside the orchestrator would
      // return `folder` — but we pass `folder` directly to avoid a race
      // where the localStorage notify hasn't flushed yet.
      void dispatchAgainstFolder(
        pending.entry,
        pending.datasourceId,
        pending.shiftKey,
        folder,
      );
    },
    [dispatchAgainstFolder],
  );

  return { dispatchDownload, modalOpen, onModalCommit };
}
