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

// --- Path joining ----------------------------------------------------

/**
 * Compose `<folder>/<filename>` defensively. The folder may come from
 * an OS picker (Windows backslashes) or from the v1 fallback string
 * (`~/Downloads/ft5`). We don't normalize separators here — the host OS
 * tolerates either; what matters is that we don't double-slash. Mirrors
 * `joinDatasourcePath` from `use-upload-orchestrator.ts`.
 */
function joinFolderAndName(folder: string, filename: string): string {
  const trimmedFolder = folder.endsWith("/") || folder.endsWith("\\")
    ? folder.slice(0, -1)
    : folder;
  const trimmedName = filename.startsWith("/") || filename.startsWith("\\")
    ? filename.slice(1)
    : filename;
  // Folder paths picked from the OS use the host separator; the v1
  // fallback uses POSIX. Use `/` here — Electron's `dialog.showSaveDialog`
  // and Node's fs accept forward slashes on Windows too.
  return `${trimmedFolder}/${trimmedName}`;
}

// --- Hook ------------------------------------------------------------

export function useDownloadOrchestrator(
  options?: UseDownloadOrchestratorOptions,
): UseDownloadOrchestratorResult {
  const api = resolveApi(options?.api);
  const pendingRef = useRef<PendingDownload | null>(null);
  const [modalOpen, setModalOpen] = useState<boolean>(false);

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

      return api.download({
        datasourceId,
        path: entry.path,
        toPath,
      });
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
