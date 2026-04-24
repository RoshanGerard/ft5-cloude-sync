"use client";

//
// UploadDialog (Task 6) — in-app file + destination picker.
//
// Both the datasource card's "Upload from local…" quick-action and the
// file-explorer toolbar's Upload button open this dialog. See
// openspec/changes/add-file-explorer-drag-drop-upload/specs/file-explorer/spec.md
// "Upload dialog — in-app file + destination picker" and
// design.md § Visual direction.
//
// Interaction model (spec decision 5):
//   The currently-displayed folder IS the destination — no separate row
//   selection. Clicking a directory row navigates INTO it; the synthesized
//   `.. (parent)` row and breadcrumb navigate UP / jump. This mirrors the
//   OS "Save As" / folder-picker convention.
//
// Lifecycle reset (spec line 105): closing the dialog discards the Files
// list and navigation state. We reset state when `open` transitions
// false → true so reopening starts fresh.
//
// The dialog itself does NOT call `files.upload`. On submit it
// instantiates the shared `createUploadOrchestrator` with the current
// files + destination; the orchestrator walks preflight / conflict
// resolution / dispatch. Task 7 replaces the stub resolver, Task 9
// replaces the stub toaster — the dialog's contract stays unchanged.

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

import {
  createUploadOrchestrator,
  type ConflictResolver,
  type UploadFileItem,
  type UploadToaster,
} from "./use-upload-orchestrator.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface UploadDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly datasourceId: string;
  readonly datasourceName: string;
  /**
   * Initial destination path. Card opens the dialog with `/`; the
   * file-explorer toolbar opens with the current folder's path.
   */
  readonly initialDestination: string;
  readonly conflictResolver: ConflictResolver;
  readonly toaster: UploadToaster;
}

// ---------------------------------------------------------------------------
// Path helpers — breadcrumb derivation + parent navigation
// ---------------------------------------------------------------------------

interface Segment {
  readonly name: string;
  readonly path: string;
}

function segmentsFor(currentPath: string): readonly Segment[] {
  const parts = currentPath.split("/").filter((p) => p.length > 0);
  const out: Segment[] = [{ name: "root", path: "/" }];
  for (let i = 0; i < parts.length; i += 1) {
    const name = parts[i];
    if (typeof name !== "string") continue;
    out.push({ name, path: "/" + parts.slice(0, i + 1).join("/") });
  }
  return out;
}

function parentOf(path: string): string {
  if (path === "/") return "/";
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length <= 1) return "/";
  return "/" + parts.slice(0, -1).join("/");
}

function basenameOf(osPath: string): string {
  // The dialog accepts OS-absolute paths from the native picker — both
  // Windows (`C:\\foo\\bar.txt`) and POSIX (`/tmp/bar.txt`). Normalize
  // both separators, then take the last segment.
  const normalized = osPath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((p) => p.length > 0);
  return parts.at(-1) ?? osPath;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// window.api surfaces used by the dialog. Narrow typing so tests that
// stub only these members satisfy the compiler without `any`.
// ---------------------------------------------------------------------------

interface PickFilesApi {
  readonly pickFilesToUpload: () => Promise<{
    readonly filePaths: readonly string[];
    readonly canceled: boolean;
  }>;
}

interface FilesListApi {
  readonly list: (req: {
    readonly datasourceId: string;
    readonly path: string;
  }) => Promise<
    | {
        readonly ok: true;
        readonly value: { readonly entries: readonly FileEntry[] };
      }
    | { readonly ok: false; readonly error: { readonly message: string } }
  >;
}

function getFilesListApi(): FilesListApi | null {
  const api = (
    globalThis as unknown as {
      window?: { api?: { files?: FilesListApi } };
    }
  ).window?.api?.files;
  return api ?? null;
}

function getPickFilesApi(): PickFilesApi | null {
  const api = (
    globalThis as unknown as {
      window?: { api?: { datasources?: PickFilesApi } };
    }
  ).window?.api?.datasources;
  return api ?? null;
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function UploadDialog(props: UploadDialogProps): ReactElement {
  const {
    open,
    onOpenChange,
    datasourceId,
    datasourceName,
    initialDestination,
    conflictResolver,
    toaster,
  } = props;

  // Files queued for upload. Reset when the dialog opens (spec line 105).
  const [files, setFiles] = useState<readonly UploadFileItem[]>([]);
  // Currently-displayed destination folder — ALSO the destination (no
  // separate row-selection state per design Decision 5).
  const [currentDestination, setCurrentDestination] = useState<string>(
    initialDestination,
  );
  // Directory-only entries for the currently-displayed destination.
  const [directories, setDirectories] = useState<readonly FileEntry[]>([]);

  // Reset transient state when opening. Only resets on the false → true
  // edge so cross-render state (e.g. directory listing after navigation)
  // is preserved while the dialog is open.
  useEffect(() => {
    if (open) {
      setFiles([]);
      setCurrentDestination(initialDestination);
    }
  }, [open, initialDestination]);

  // Re-fetch directory listing whenever `currentDestination` changes while
  // the dialog is open. Stale-response guard: a fast sequence of
  // navigations could land out-of-order; the captured `path` check below
  // ensures only the most recent request writes to state.
  useEffect(() => {
    if (!open) return;
    const api = getFilesListApi();
    if (!api) return;
    let cancelled = false;
    void (async () => {
      const response = await api.list({
        datasourceId,
        path: currentDestination,
      });
      if (cancelled) return;
      if (!response.ok) {
        // Stay on the current destination with an empty directory list;
        // failure UX for the destination tree is out of scope for v1.
        setDirectories([]);
        return;
      }
      const entries = response.value.entries.filter(
        (e) => e.kind === "directory",
      );
      setDirectories(entries);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, datasourceId, currentDestination]);

  const breadcrumbSegments = useMemo(
    () => segmentsFor(currentDestination),
    [currentDestination],
  );

  const handleAddFiles = useCallback(async () => {
    const api = getPickFilesApi();
    if (!api) return;
    const result = await api.pickFilesToUpload();
    if (result.canceled || result.filePaths.length === 0) return;
    const additions: UploadFileItem[] = result.filePaths.map((p) => ({
      sourcePath: p,
      basename: basenameOf(p),
      // Size is unknown until an IPC round-trip; rendering 0 here is
      // honest (the orchestrator doesn't rely on it).
      sizeBytes: 0,
    }));
    setFiles((prev) => [...prev, ...additions]);
  }, []);

  const handleRemoveFile = useCallback((sourcePath: string) => {
    setFiles((prev) => prev.filter((f) => f.sourcePath !== sourcePath));
  }, []);

  const handleNavigateInto = useCallback((entry: FileEntry) => {
    setCurrentDestination(entry.path);
  }, []);

  const handleNavigateUp = useCallback(() => {
    setCurrentDestination((prev) => parentOf(prev));
  }, []);

  const handleBreadcrumbJump = useCallback((path: string) => {
    setCurrentDestination(path);
  }, []);

  const handleSubmit = useCallback(() => {
    if (files.length === 0) return;
    const orchestrator = createUploadOrchestrator({
      datasourceId,
      targetDir: currentDestination,
      files,
      conflictResolver,
      toaster,
    });
    // Fire-and-forget — per-job toasts surface status. Close the dialog
    // immediately after dispatching so the user isn't blocked by the
    // fan-out. Spec: "the Upload dialog closes within one render of the
    // dispatch".
    void orchestrator.start();
    onOpenChange(false);
  }, [
    conflictResolver,
    currentDestination,
    datasourceId,
    files,
    onOpenChange,
    toaster,
  ]);

  const submitDisabled = files.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="upload-dialog">
        <DialogHeader>
          <DialogTitle>Upload to {datasourceName}</DialogTitle>
          <DialogDescription className="sr-only">
            Choose files and a destination folder, then upload.
          </DialogDescription>
        </DialogHeader>

        {/* ---------------------------- Files section --------------------- */}
        <section
          aria-labelledby="upload-dialog-files-heading"
          className="flex flex-col gap-2 rounded-md border p-3"
        >
          <h3
            id="upload-dialog-files-heading"
            className="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            Files to upload
          </h3>
          {files.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No files selected. Click + Add files… to choose.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {files.map((f) => (
                <li
                  key={f.sourcePath}
                  data-testid="upload-dialog-file-row"
                  className="flex items-center gap-2 text-sm"
                >
                  <Icon name="file" aria-hidden className="size-4 shrink-0" />
                  <span className="flex-1 truncate">{f.basename}</span>
                  <span className="text-muted-foreground tabular-nums text-xs">
                    {f.sizeBytes !== undefined && f.sizeBytes > 0
                      ? formatBytes(f.sizeBytes)
                      : ""}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${f.basename}`}
                    data-testid="upload-dialog-file-remove"
                    onClick={() => handleRemoveFile(f.sourcePath)}
                  >
                    <span aria-hidden>×</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start text-primary"
            data-testid="upload-dialog-add-files"
            onClick={() => void handleAddFiles()}
          >
            <Icon name="plus" aria-hidden className="size-4" />
            Add files…
          </Button>
        </section>

        {/* ---------------------------- Destination section --------------- */}
        <section
          aria-labelledby="upload-dialog-destination-heading"
          className="flex flex-col gap-2 rounded-md border p-3"
        >
          <h3
            id="upload-dialog-destination-heading"
            className="text-muted-foreground text-xs font-semibold uppercase tracking-wide"
          >
            Destination folder
          </h3>
          {/* Breadcrumb — inline, matches explorer Breadcrumb style but
              decoupled from ExplorerStore (destination is local state). */}
          <nav
            aria-label="Destination folder path"
            data-testid="upload-dialog-breadcrumb"
            className="flex min-w-0 items-center"
          >
            <ol className="flex min-w-0 items-center gap-1 text-sm">
              {breadcrumbSegments.map((seg, i) => {
                const isLast = i === breadcrumbSegments.length - 1;
                return (
                  <li key={seg.path} className="flex items-center gap-1">
                    {i > 0 ? (
                      <Icon
                        name="chevron-right"
                        className="text-muted-foreground size-3"
                        aria-hidden
                      />
                    ) : null}
                    {isLast ? (
                      <span
                        aria-current="page"
                        className="text-foreground truncate px-1"
                      >
                        {seg.name}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleBreadcrumbJump(seg.path)}
                        className="text-muted-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 truncate rounded-md px-1 outline-none transition-colors focus-visible:ring-[3px]"
                      >
                        {seg.name}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          {/* Directory list — max-h 140px, scrollable (no ScrollArea
              dependency; a plain div with overflow-y-auto is enough). */}
          <div
            className="max-h-[140px] overflow-y-auto"
            data-testid="upload-dialog-directory-list"
          >
            <ul className="flex flex-col gap-1">
              {currentDestination !== "/" ? (
                <li>
                  <button
                    type="button"
                    data-testid="upload-dialog-parent-row"
                    onClick={handleNavigateUp}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm",
                      "hover:bg-accent focus-visible:border-ring focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
                    )}
                  >
                    <Icon name="folder" aria-hidden className="size-4" />
                    <span>.. (parent)</span>
                  </button>
                </li>
              ) : null}
              {directories.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    data-testid="upload-dialog-dir-row"
                    onClick={() => handleNavigateInto(entry)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm",
                      "hover:bg-accent focus-visible:border-ring focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
                    )}
                  >
                    <Icon name="folder" aria-hidden className="size-4" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <p
            className="text-muted-foreground text-xs"
            data-testid="upload-dialog-destination-footer"
          >
            → {currentDestination}
          </p>
        </section>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="upload-dialog-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={submitDisabled}
            onClick={handleSubmit}
            data-testid="upload-dialog-submit"
          >
            Upload {files.length} {files.length === 1 ? "file" : "files"} → {currentDestination}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
