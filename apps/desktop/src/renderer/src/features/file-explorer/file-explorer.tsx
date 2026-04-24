"use client";

//
// FileExplorer — composite wiring (Subagent P, Phase 4 composite).
//
// Replaces the Phase 2.4 placeholder with the real explorer layout:
//   - Top chrome row: HistoryButtons | Breadcrumb (flex-1) | Toolbar
//   - Main pane: ViewModeSwitcher (loading / error / populated states)
//   - Bottom: StatusRow (aria-live)
//
// The `data-testid="file-explorer-root"` anchor is preserved for
// continuity with the route-level tests in `page.test.tsx`.
//
// Scope boundaries (called out in the Phase 4 composite-wiring commit):
//   - onActivate wires directory entries to `store.navigate`; file
//     activation is a no-op (Phase 5 wires the Properties modal).
//   - onDelete / onRename / onDownload / onProperties are no-ops
//     (Phase 5 / Phase 6 wire these to real actions).
//   - onCopyPath writes to `navigator.clipboard.writeText(entry.path)`
//     when the API is available; Phase 9 adds a sonner toast + error
//     surfacing.
//   - onContextMenuRequested (Shift+F10 / ContextMenu key from
//     `useKeyboardNav`) imperatively dispatches a native
//     `contextmenu` event at the focused entry's DOM node. Every view
//     mode stamps `data-entry-id` on its cells so the lookup
//     succeeds regardless of the active mode.
//

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

import type { FileEntry, FilesRemoveTarget } from "@ft5/ipc-contracts";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icon";

import { Breadcrumb } from "./breadcrumb";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog";
import { DetailsPane } from "./details-pane";
import { DropZone, type DropZoneStatus } from "./drop-zone";
import { HistoryButtons } from "./history-buttons";
import { PropertiesModal } from "./properties-modal";
import { ProviderKindContext } from "./provider-kind-context";
import type {
  ConflictResolver,
  UploadToaster,
} from "./use-upload-orchestrator";
import {
  SearchResults,
  isEngineBacked,
  type ProviderKind,
} from "./search-results";
import { AuthRevokedState } from "./states/auth-revoked";
import { DisconnectedState } from "./states/disconnected";
import { EmptyState } from "./states/empty";
import { Skeleton } from "./states/skeleton";
import { SyncingState } from "./states/syncing";
import { getOrCreateExplorerStore } from "./store";
import { StatusRow } from "./status-row";
import { Toolbar } from "./toolbar";
import { UploadDialog } from "./upload-dialog";
import { STUB_CONFLICT_RESOLVER, STUB_TOASTER } from "./upload-stubs";
import { useExplorerData } from "./use-explorer-data";
import { useKeyboardNav } from "./use-keyboard-nav";
import { ViewModeSwitcher } from "./view-mode-switcher";

import type { DatasourceStatus } from "@ft5/ipc-contracts";

export interface FileExplorerProps {
  datasourceId: string;
  /**
   * Presentation-layer provider kind for the datasource being explored.
   * Passed down to `<SearchResults>` so the deferred-state surface knows
   * the human-readable provider name. Optional because pre-search phases
   * of the renderer (view modes, breadcrumb, details pane) don't need it;
   * the route layer derives it from the matched `DatasourceSummary` and
   * passes it in. When absent we fall back to `"s3"` — S3 handlers never
   * defer, so the deferred branch stays dormant and unit/composite tests
   * that predate this prop keep working unchanged.
   */
  providerKind?: ProviderKind;
  /**
   * Optional sync-service status for the datasource, surfaced by the
   * route layer. When `"syncing"` and the list response is either
   * in-flight or resolved empty, the explorer renders the `<SyncingState>`
   * instead of skeleton / empty. Once the list resolves with non-empty
   * entries the engine response wins regardless of this status.
   */
  providerStatus?: DatasourceStatus;
  /**
   * Optional conflict resolver forwarded to the drop-zone's upload
   * orchestrator. Task 7 wires the real shadcn-dialog-backed resolver;
   * until then the default is a stub that surfaces a "coming soon" toast
   * on any conflict so drops against colliding names don't fail silently.
   * Remove this stub when Task 7 lands.
   */
  conflictResolver?: ConflictResolver;
  /**
   * Optional per-job toaster forwarded to the drop-zone's upload
   * orchestrator. Task 9 wires the real Sonner-backed per-job surface;
   * until then the default emits a single informational toast when a job
   * is dispatched and a red toast on batch error. Remove the stub when
   * Task 9 lands.
   */
  toaster?: UploadToaster;
}

/**
 * Back-to-dashboard affordance. The spec's "back returns to the
 * dashboard" scenario originally leaned on browser-level back, which
 * Electron does not surface in its chromeless window. A discoverable
 * in-app home button is the pointer-friendly analog. Kept as a sibling
 * of HistoryButtons (not inside it) so the existing history-stack
 * semantics stay unchanged.
 */
function DashboardHomeButton() {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="Back to dashboard"
      data-testid="file-explorer-dashboard-home"
      onClick={() => router.push("/")}
    >
      <Icon name="home" aria-hidden="true" />
    </Button>
  );
}

// Task-6 refactor: the temporary conflict-resolver + toaster stubs now
// live in `./upload-stubs.ts` so BOTH the drop-zone (explorer) and the
// Upload-dialog entry points (toolbar + datasource card) share identical
// placeholder behaviour. Tasks 7 / 9 replace the stubs in one place.

export function FileExplorer({
  datasourceId,
  providerKind = "s3",
  providerStatus,
  conflictResolver = STUB_CONFLICT_RESOLVER,
  toaster = STUB_TOASTER,
}: FileExplorerProps) {
  const router = useRouter();
  // Grab the per-datasource store directly — the module-level cache
  // ensures this is the same instance for every mount with the same id.
  // We subscribe to its state once here; child chrome components accept
  // the store prop and subscribe themselves with `useSyncExternalStore`.
  const store = getOrCreateExplorerStore(datasourceId);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  // Kick off the data-loading effect. Re-fires whenever `currentPath`
  // on the store changes; stale-response guard lives in the hook.
  useExplorerData(store, datasourceId);

  // Upload dialog state — opened by the toolbar Upload button (Task 6.4).
  // Dialog is controlled (not Radix-trigger-managed) so the file-explorer
  // owns both open/close AND the `initialDestination` handoff to the
  // dialog's destination tree. Reset happens inside the dialog on each
  // false → true transition (see upload-dialog.tsx).
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);

  // Confirm-delete dialog state — targets captured at click-time. Each
  // target carries the authoritative engine `handle` so the downstream
  // files:remove call addresses unambiguously (critical for providers
  // like Google Drive where multiple entries can share a path). `path`
  // is preserved purely for the per-entry response-envelope match.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingDeleteRef = useRef<FilesRemoveTarget[]>([]);

  const entryToRemoveTarget = (e: FileEntry): FilesRemoveTarget => ({
    path: e.path,
    handle: e.id,
    kind: e.kind,
  });

  // Search → navigate handoff. When a search result is activated the
  // composite clears the search + navigates to the entry's parentPath.
  // Because `useExplorerData` fetches the new folder asynchronously,
  // we can't call `keyboardNav.setFocusedId(entry.id)` synchronously —
  // the new entries aren't in state yet. Instead we stash the id AND
  // the expected parent path in a ref and apply it once `currentPath`
  // reaches `parentPath` and the loading flag has settled. Tracking the
  // path is what keeps the drain from firing against the stale entries
  // of the previous folder in the render that falls between
  // `store.navigate` and `useExplorerData`'s first `setLoading(true)`.
  // `sawLoading` flips once the data-hook has signalled a load for the
  // target path; a subsequent loading=false edge without the entry
  // present means it vanished (moved/deleted) and we drop the pending
  // id rather than leaking it across the next navigation.
  const pendingFocusRef = useRef<{
    id: string;
    path: string;
    sawLoading: boolean;
  } | null>(null);

  const entriesById = new Map(state.entries.map((e) => [e.id, e] as const));
  const targetsForSelection = (): FilesRemoveTarget[] => {
    const out: FilesRemoveTarget[] = [];
    for (const id of state.selection) {
      const entry = entriesById.get(id);
      if (entry !== undefined) out.push(entryToRemoveTarget(entry));
    }
    return out;
  };

  const openConfirmDelete = (targets: FilesRemoveTarget[]): void => {
    if (targets.length === 0) return;
    pendingDeleteRef.current = targets;
    setConfirmOpen(true);
  };

  const keyboardNav = useKeyboardNav(store, {
    entries: state.entries,
    onActivate: (entry) => {
      if (entry.kind === "directory") {
        store.navigate(entry.path);
      }
      // File activation is a v1 no-op; Phase 5 wires Enter-on-file to
      // the Properties modal per design.md Open Question "Does Enter
      // on a file open Properties".
    },
    // F2 on a file flips the name cell to an inline input; the store's
    // editingId + EntryNameCell do the rest. Engine-backed datasources
    // gate this — Rename is disabled for them until
    // `add-engine-rename-download` lands.
    onRenameRequested: (entry) => {
      if (isEngineBacked(providerKind)) return;
      store.startEdit(entry.id);
    },
    onDeleteRequested: (entries) => {
      openConfirmDelete(entries.map(entryToRemoveTarget));
    },
    onContextMenuRequested: (entry) => {
      // Programmatic open: find the focused entry's DOM node by
      // `data-entry-id` and dispatch a native contextmenu event. Radix
      // ContextMenu's trigger listens on `contextmenu`, so this opens
      // the per-cell menu without needing a ref map.
      const el = document.querySelector<HTMLElement>(
        `[data-entry-id="${entry.id}"]`,
      );
      if (el === null) return;
      el.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    },
  });

  // Per-entry action handlers forwarded through ViewModeSwitcher down
  // into each view mode's `FileContextMenu`. Only the composite
  // supplies real handlers; view-mode tests mount without these and
  // the menu items become silent no-ops (Radix tolerates undefined
  // onSelect handlers — the context-menu component wraps each in
  // `() => on*?.(entry)`).
  const handleOpen = (entry: FileEntry) => {
    if (entry.kind === "directory") {
      store.navigate(entry.path);
    }
    // Files: Phase 5 wires this to the Properties modal.
  };
  const handleCopyPath = (entry: FileEntry) => {
    // FileContextMenu already writes to clipboard internally; this
    // callback is a hook for a future toast in Phase 9. Kept no-op
    // here so the writeText call isn't doubled.
    void entry;
  };
  // Context-menu Delete: if the entry is in the current selection,
  // delete the full selection; otherwise delete just that entry.
  const handleContextDelete = (entry: FileEntry) => {
    if (state.selection.has(entry.id)) {
      openConfirmDelete(targetsForSelection());
    } else {
      openConfirmDelete([entryToRemoveTarget(entry)]);
    }
  };

  const handleToolbarDelete = () => {
    openConfirmDelete(targetsForSelection());
  };

  const handleConfirmDelete = () => {
    const targets = pendingDeleteRef.current;
    pendingDeleteRef.current = [];
    setConfirmOpen(false);
    void store.remove(targets);
  };

  const handleRetry = () => {
    store.retryLoad();
  };

  const handleReconnect = () => {
    // The OAuth / reconnect flow itself is out of scope for
    // wire-file-explorer-to-service — see proposal.md "Out of scope"
    // and the follow-up `implement-datasource-onboarding`. Routing the
    // user back to the dashboard puts them in front of the datasource
    // card where the reconnect affordance will live.
    router.push("/");
  };

  const handleCancelDelete = () => {
    pendingDeleteRef.current = [];
    setConfirmOpen(false);
  };

  // Context-menu Download fires the store's one-shot download action.
  const handleDownload = (entry: FileEntry) => {
    void store.download(entry.id);
  };

  // Click on a search result: remember the entry id + target parent path,
  // clear the search, navigate to the parent folder. The useEffect below
  // picks up the pending id once the path has actually switched and the
  // new path's entries have loaded.
  const handleSearchResultActivate = (entry: FileEntry) => {
    pendingFocusRef.current = {
      id: entry.id,
      path: entry.parentPath,
      sawLoading: false,
    };
    store.clearSearch();
    store.navigate(entry.parentPath);
  };

  // Drain the pending focus id once entries for the new path arrive.
  // We only act when:
  //   - `currentPath` matches the remembered target path (guards the
  //     render between `store.navigate` and `useExplorerData`'s first
  //     `setLoading(true)`, where entries still reflect the old folder)
  //   - `loading` is false (entries have actually arrived)
  // Drop the pending id if the entry vanished (moved/deleted between
  // click and re-fetch) so we don't wait forever.
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending === null) return;
    if (state.currentPath !== pending.path) return;
    // Record that the data hook has begun a load for the target path.
    // Without this marker we can't distinguish "entries haven't loaded
    // yet" from "entries loaded and the entry isn't there" — React
    // doesn't guarantee effect ordering between this component and
    // `useExplorerData`, so after `store.navigate(path)` there's an
    // intermediate render where `currentPath` has flipped but
    // `loading` is still `false` (data effect's `setLoading(true)`
    // hasn't fired yet) and `entries` still reflects the OLD folder.
    if (state.loading) {
      pending.sawLoading = true;
      return;
    }
    if (state.entries.some((e) => e.id === pending.id)) {
      keyboardNav.setFocusedId(pending.id);
      pendingFocusRef.current = null;
      return;
    }
    // Entries don't contain the target. Only drop the pending id once
    // the load for this path has actually completed (sawLoading true
    // then back to false) — that means the entry vanished between the
    // search click and the re-fetch. Before that, we're still in the
    // intermediate render and must wait.
    if (pending.sawLoading) {
      pendingFocusRef.current = null;
    }
  }, [state.currentPath, state.entries, state.loading, keyboardNav]);

  // DropZone status — derived inline from the two signals the composite
  // already consults. `errorTag` from the engine envelope wins for the
  // disconnected / auth-revoked cases; `providerStatus` covers syncing.
  // NOTE: the `DatasourceStatus` contract type doesn't model "disconnected"
  // or "auth-revoked" directly — those live on the files.list error
  // envelope. The drop-zone uses its own `DropZoneStatus` union that
  // matches the spec's blocking rule exactly.
  const dropZoneStatus: DropZoneStatus = useMemo(() => {
    if (state.errorTag === "disconnected") return "disconnected";
    if (state.errorTag === "auth-revoked") return "auth-revoked";
    if (providerStatus === "syncing") return "syncing";
    return "usable";
  }, [state.errorTag, providerStatus]);

  // Upload-button gate: the toolbar Upload button mirrors the drop-zone
  // blocked rule (spec line 73). Non-null string = aria-disabled + tooltip;
  // null = enabled. Keep the reasons short — they surface via `title` (OS
  // tooltip) and are read by AT.
  const uploadBlockedReason: string | null = useMemo(() => {
    switch (dropZoneStatus) {
      case "disconnected":
        return "This datasource is disconnected";
      case "auth-revoked":
        return "Sign in again to upload";
      case "syncing":
        return "This datasource is still indexing — try again in a moment";
      default:
        return null;
    }
  }, [dropZoneStatus]);

  return (
    <ProviderKindContext.Provider value={providerKind}>
    <DropZone
      datasourceId={datasourceId}
      currentPath={state.currentPath}
      status={dropZoneStatus}
      conflictResolver={conflictResolver}
      toaster={toaster}
    >
    <div
      data-testid="file-explorer-root"
      className="bg-background flex flex-1 min-h-0 flex-col"
    >
      {/* Chrome row: dashboard-home + history buttons + breadcrumb + toolbar. */}
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <DashboardHomeButton />
        <HistoryButtons store={store} />
        <div className="min-w-0 flex-1">
          <Breadcrumb store={store} />
        </div>
        <Toolbar
          store={store}
          onDeleteSelection={handleToolbarDelete}
          onUploadClick={() => setUploadDialogOpen(true)}
          uploadBlockedReason={uploadBlockedReason}
        />
      </div>

      {/* overflow-auto on the main column so scrolling entries does not scroll the Details pane. */}
      <div className="flex min-h-0 flex-1 flex-row">
        <div className="flex min-w-0 flex-1 flex-col overflow-auto">
          {(() => {
            // Search surface preempts state rendering — once the user
            // activates a search, the results surface is authoritative.
            if (state.search.active) {
              return (
                <SearchResults
                  store={store}
                  providerKind={providerKind}
                  onResultActivate={handleSearchResultActivate}
                />
              );
            }
            // Tagged-error envelope branches. Engine response wins over
            // the optional `providerStatus` hint — once an errorTag is
            // set we trust it for the current folder.
            if (state.errorTag === "disconnected") {
              return <DisconnectedState onRetry={handleRetry} />;
            }
            if (state.errorTag === "auth-revoked") {
              return <AuthRevokedState onReconnect={handleReconnect} />;
            }
            // rate-limited / other: no dedicated full-replace state
            // component; surface the error inline so the user sees
            // *why* the main pane is empty rather than assuming the
            // folder itself is empty.
            if (state.errorTag !== null && state.error !== null) {
              return (
                <div
                  data-testid="file-explorer-error"
                  role="alert"
                  className="text-destructive p-4 text-sm"
                >
                  Failed to load: {state.error}
                </div>
              );
            }
            // While loading: syncing preempts skeleton only if the
            // provider is mid-initial-sync AND no prior entries are
            // visible (otherwise flashing mid-navigation would feel
            // jarring).
            if (state.loading) {
              if (
                providerStatus === "syncing" &&
                state.entries.length === 0
              ) {
                return <SyncingState />;
              }
              return <Skeleton mode={state.viewMode} />;
            }
            // Resolved: rate-limited / other errors surface via the
            // existing lastError-driven inline surfaces; the main pane
            // still routes through empty / entries. `errorTag` ==
            // "rate-limited" | "other" intentionally falls through to
            // empty/entries so the error surfaces as a toast rather
            // than hiding the current folder.
            if (state.entries.length === 0) {
              if (providerStatus === "syncing") {
                return <SyncingState />;
              }
              return <EmptyState />;
            }
            return (
              <ViewModeSwitcher
                store={store}
                keyboardNav={keyboardNav}
                onOpen={handleOpen}
                onDownload={handleDownload}
                onRename={(entry) => {
                  // Mirror the F2 keyboard guard — engine-backed
                  // datasources disable rename at the menu level, but
                  // a guard here prevents any direct caller from
                  // bypassing the UI disable.
                  if (isEngineBacked(providerKind)) return;
                  store.startEdit(entry.id);
                }}
                onDelete={handleContextDelete}
                onCopyPath={handleCopyPath}
                onProperties={(entry) => store.openProperties(entry)}
              />
            );
          })()}
        </div>
        <DetailsPane store={store} />
      </div>

      {/* Status row pinned to bottom. */}
      <StatusRow store={store} />
      <PropertiesModal store={store} />
      <ConfirmDeleteDialog
        open={confirmOpen}
        count={pendingDeleteRef.current.length}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
      {/* Upload dialog, opened by the toolbar's Upload button. Default
          destination = file-explorer's currentPath (spec line 30). The
          dialog internally resets its Files list + navigation state on
          each false → true transition so reopening starts fresh. */}
      <UploadDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        datasourceId={datasourceId}
        datasourceName={datasourceId}
        initialDestination={state.currentPath}
        conflictResolver={conflictResolver}
        toaster={toaster}
      />
    </div>
    </DropZone>
    </ProviderKindContext.Provider>
  );
}
