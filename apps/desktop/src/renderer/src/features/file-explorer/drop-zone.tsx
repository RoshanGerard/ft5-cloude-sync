"use client";

//
// DropZone — drag-drop wrapper around the file-explorer pane.
//
// Behaviour:
//   - Tracks `isDragActive` with an enter-count (see `dragEnterCountRef`)
//     so React's dragenter/dragleave bubble order doesn't flicker the
//     overlay as the pointer moves between child elements.
//   - Activates overlay ONLY when `dataTransfer.types` includes "Files".
//     Text / URL drags are ignored per spec § "Dragover of non-file data".
//   - When the datasource cannot accept uploads (status != "usable"),
//     renders the neutral blocked overlay AND makes drop a no-op — no
//     files.upload calls, no toast.
//   - Folder detection via `DataTransferItem.webkitGetAsEntry()`. A single
//     Sonner toast fires if any folder is in the drop batch; the files in
//     the batch still upload (per spec § "Mixed file + folder drop").
//
// Electron note: Electron 32+ removed the `File.path` augmentation.
// Production code now reads the absolute filesystem path via
// `window.api.webUtils.getPathForFile(file)` (a contextBridge wrapper
// around `electron.webUtils.getPathForFile`). Tests still set `.path`
// directly on fake File objects; `resolveSourcePath` checks the bridge
// first and falls back to `(file as any).path` so JSDOM tests keep
// working without stubbing `window.api.webUtils`.
//
// The orchestrator hook is instantiated INSIDE this component (not in the
// route layer) so the call to `createUploadOrchestrator` happens once per
// drop with the correct file list. Task 9 will wire the toaster surface;
// Task 7 will wire the conflict resolver.

import { useCallback, useRef, useState, type ReactElement } from "react";
import { toast } from "sonner";

import { DropOverlay, type DropOverlayBlockedReason } from "./drop-overlay";
import {
  createUploadOrchestrator,
  type ConflictResolver,
  type UploadFileItem,
  type UploadOrchestratorApi,
  type UploadToaster,
} from "./use-upload-orchestrator";

export type DropZoneStatus = "usable" | DropOverlayBlockedReason;

const BLOCKED_STATUSES: ReadonlySet<DropZoneStatus> = new Set([
  "disconnected",
  "auth-revoked",
  "syncing",
]);

export interface DropZoneProps {
  readonly datasourceId: string;
  readonly currentPath: string;
  readonly status: DropZoneStatus;
  readonly conflictResolver: ConflictResolver;
  readonly toaster: UploadToaster;
  /**
   * Injected API for tests; production falls back to `window.api.files`
   * via `createUploadOrchestrator`'s own resolver.
   */
  readonly api?: UploadOrchestratorApi;
  readonly children: React.ReactNode;
}

/**
 * Test-only File augmentation. Tests still set `.path` directly on fake
 * File objects (production File objects no longer carry `.path` as of
 * Electron 32). The resolver below honors this shape as a fallback.
 */
interface FileWithPath extends File {
  readonly path?: string;
}

function resolveSourcePath(file: FileWithPath): string {
  // Production: contextBridge-exposed `electron.webUtils.getPathForFile`.
  const w = globalThis as unknown as {
    window?: { api?: { webUtils?: { getPathForFile?: (f: File) => string } } };
  };
  const fromWebUtils = w.window?.api?.webUtils?.getPathForFile?.(file);
  if (typeof fromWebUtils === "string" && fromWebUtils.length > 0) {
    return fromWebUtils;
  }
  // Test fallback: fake File objects with `.path` defined inline.
  return file.path ?? "";
}

function isBlocked(status: DropZoneStatus): status is DropOverlayBlockedReason {
  return BLOCKED_STATUSES.has(status);
}

function dataTransferHasFiles(dt: DataTransfer | null): boolean {
  if (dt === null) return false;
  // `types` is a DOMStringList in the DOM spec and a plain string[] under
  // JSDOM + tests; `.includes` works on arrays, `.contains` on DOMStringList.
  // Normalize via Array.from.
  const types = Array.from(dt.types ?? []);
  return types.includes("Files");
}

interface DropClassification {
  readonly files: UploadFileItem[];
  readonly hasFolder: boolean;
}

function classifyDrop(dt: DataTransfer | null): DropClassification {
  const files: UploadFileItem[] = [];
  let hasFolder = false;
  if (dt === null) return { files, hasFolder };

  // Prefer `items` because it lets us ask `webkitGetAsEntry()` per item —
  // the only reliable way to detect a folder in a drop before crawling it.
  const items = dt.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || item.kind !== "file") continue;
      const entry =
        typeof item.webkitGetAsEntry === "function"
          ? item.webkitGetAsEntry()
          : null;
      if (entry && entry.isDirectory) {
        hasFolder = true;
        continue;
      }
      const file = item.getAsFile() as FileWithPath | null;
      if (!file) continue;
      const sourcePath = resolveSourcePath(file);
      if (sourcePath.length === 0) continue;
      files.push({
        sourcePath,
        basename: file.name,
        sizeBytes: file.size,
      });
    }
    return { files, hasFolder };
  }

  // Fallback: some environments only populate `dt.files`. We cannot
  // distinguish folders here (webkitGetAsEntry is only on items) — treat
  // everything as a file.
  const fileList = dt.files;
  if (fileList && fileList.length > 0) {
    for (let i = 0; i < fileList.length; i += 1) {
      const file = fileList.item(i) as FileWithPath | null;
      if (!file) continue;
      const sourcePath = resolveSourcePath(file);
      if (sourcePath.length === 0) continue;
      files.push({
        sourcePath,
        basename: file.name,
        sizeBytes: file.size,
      });
    }
  }
  return { files, hasFolder };
}

export function DropZone(props: DropZoneProps): ReactElement {
  const {
    datasourceId,
    currentPath,
    status,
    conflictResolver,
    toaster,
    api,
    children,
  } = props;

  const [isDragActive, setIsDragActive] = useState(false);
  // dragenter/dragleave bubble through every child — use a counter to
  // avoid flicker as the pointer moves across the explorer's internal
  // elements. The overlay goes away only when the counter returns to 0.
  const dragEnterCountRef = useRef(0);

  const blocked = isBlocked(status);

  const handleDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragEnterCountRef.current += 1;
      setIsDragActive(true);
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasFiles(e.dataTransfer)) return;
      // Must preventDefault on dragover for the subsequent drop event to
      // fire at all — this is the standard HTML5 DnD gotcha.
      e.preventDefault();
      if (!isDragActive) {
        setIsDragActive(true);
      }
    },
    [isDragActive],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasFiles(e.dataTransfer)) return;
      dragEnterCountRef.current = Math.max(0, dragEnterCountRef.current - 1);
      if (dragEnterCountRef.current === 0) {
        setIsDragActive(false);
      }
    },
    [],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragEnterCountRef.current = 0;
      setIsDragActive(false);

      // Blocked datasources: drop is a no-op. No toast, no dispatches —
      // mirrors Decision 6 ("no local queuing").
      if (blocked) return;

      const { files, hasFolder } = classifyDrop(e.dataTransfer);

      if (hasFolder) {
        toast.info(
          "Folder upload is coming soon — drop individual files for now",
        );
      }

      if (files.length === 0) return;

      const orchestrator = createUploadOrchestrator({
        datasourceId,
        targetDir: currentPath,
        files,
        conflictResolver,
        toaster,
        api,
      });
      // Fire-and-forget. The orchestrator surfaces per-file state via
      // the injected toaster — we intentionally do not await.
      void orchestrator.start();
    },
    [
      api,
      blocked,
      conflictResolver,
      currentPath,
      datasourceId,
      toaster,
    ],
  );

  return (
    <div
      data-testid="drop-zone"
      data-drop-active={isDragActive ? "true" : "false"}
      data-drop-blocked={blocked ? "true" : "false"}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <div
        className={
          isDragActive && !blocked
            ? "flex min-h-0 flex-1 flex-col opacity-35"
            : "flex min-h-0 flex-1 flex-col"
        }
      >
        {children}
      </div>
      {isDragActive ? (
        blocked ? (
          <DropOverlay kind="blocked" blockedReason={status as DropOverlayBlockedReason} />
        ) : (
          <DropOverlay kind="active" targetDir={currentPath} />
        )
      ) : null}
    </div>
  );
}
