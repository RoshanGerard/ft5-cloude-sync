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
// Post-Section-9 cleanup: the conflict-resolver port is now wired to the
// real `useConflictResolutionDialog()` hook + `<ConflictResolutionDialog>`
// component (Section 7's deliverable). The Section-6 `STUB_CONFLICT_RESOLVER`
// "coming soon" toast is gone — real conflicts now drive the actual dialog.
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
import { toast } from "sonner";

import type { FileEntry, FilesRemoveTarget } from "@ft5/ipc-contracts";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icon";

import { Breadcrumb } from "./breadcrumb";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog";
import {
  ConflictResolutionDialog,
  useConflictResolutionDialog,
} from "./conflict-resolution-dialog";
import {
  RenameConflictDialog,
  useDownloadConflictDialog,
  useRenameConflictDialog,
} from "./rename-conflict-dialog";
import { DetailsPane } from "./details-pane";
import { DropZone, type DropZoneStatus } from "./drop-zone";
import { FirstDownloadModal } from "./first-download-modal";
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
import { InvalidDatasourceState } from "./states/invalid-datasource";
import { Skeleton } from "./states/skeleton";
import { SyncingState } from "./states/syncing";
import { ConfirmRemoveDatasourceDialog } from "../datasources/confirm-remove-dialog";
import { useDatasourceActions } from "../datasources/store";
import { getOrCreateExplorerStore } from "./store";
import { StatusRow } from "./status-row";
import { Toolbar } from "./toolbar";
import { UploadDialog } from "./upload-dialog";
import { createUploadJobToaster } from "./upload-job-toast";
import {
  createDownloadJobToaster,
  type DownloadToaster,
} from "./download-job-toast";
import { useDownloadOrchestrator } from "./use-download-orchestrator";
import { useExplorerData } from "./use-explorer-data";
import { useKeyboardNav } from "./use-keyboard-nav";
import { ViewModeSwitcher } from "./view-mode-switcher";

import type { DatasourceStatus } from "@ft5/ipc-contracts";

export interface FileExplorerProps {
  datasourceId: string;
  /**
   * Provider key (`google-drive`, `onedrive`, `amazon-s3`, ...) for the
   * datasource being explored — threaded down to `<InvalidDatasourceState>`
   * so its in-place Reconnect button can call `startConsent` directly per
   * design.md Decision 4. Optional because the explore route is the only
   * call site that has it in scope (`summary.providerId`); unit / composite
   * tests that mount the explorer in isolation may omit it. When absent
   * AND the explorer enters the invalid-datasource branch, the state
   * component disables its Reconnect button per the spec's "providerId
   * unavailable" scenario.
   */
  providerId?: string;
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
   * orchestrator AND to the in-explorer Upload dialog. Defaults to the
   * real shadcn-dialog-backed `useConflictResolutionDialog()` resolver
   * (Section 7) that prompts the user per-file with Overwrite / Keep both
   * / Skip / Cancel-all and an "apply to remaining" checkbox. Tests that
   * want deterministic walking inject their own resolver via this prop.
   */
  conflictResolver?: ConflictResolver;
  /**
   * Optional per-job toaster forwarded to the drop-zone's upload
   * orchestrator. Defaults to the real Sonner-backed `createUploadJobToaster`
   * (Task 9): each dispatched job opens its own progress toast bound to
   * `DATASOURCES_CHANNELS.uploadProgress`, flips to success on terminal
   * complete (auto-dismiss 4s), or to red with Retry on terminal failure.
   * Tests inject their own toaster via this prop and bypass Sonner.
   */
  toaster?: UploadToaster;
  /**
   * Optional callback invoked after the user confirms Remove from the
   * `<InvalidDatasourceState>`'s `<ConfirmRemoveDatasourceDialog>` AND
   * the `actions.remove({ datasourceId })` IPC resolves. The route layer
   * uses this to navigate the user out of the explore surface (the
   * underlying datasource no longer exists, so a re-fetch would loop
   * back into the same `invalid-datasource` arm — see
   * `openspec/changes/add-invalid-datasource-state/specs/file-explorer/spec.md`
   * "On successful Remove (the IPC call resolves and a `datasource-removed`
   * event arrives), the file-explorer route SHALL navigate back to /").
   * Tests that mount `<FileExplorer>` in isolation may omit it.
   */
  onDatasourceRemoved?: () => void;
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

// Both upload entry points (drop-zone + Upload dialog) share a single
// `useConflictResolutionDialog()` instance per FileExplorer mount so the
// hook's `<ConflictResolutionDialog>` only needs to be rendered once.
// Tests inject their own `conflictResolver` via the prop and bypass the
// hook entirely (the hook still mounts but its `dialogProps.open` stays
// false because no production resolver is in play). The toaster stub
// was removed in Task 9 — `createUploadJobToaster()` is now the
// production default.

/**
 * Renders the invalid-datasource Pattern-A state plus its companion
 * <ConfirmRemoveDatasourceDialog>. Gated behind the
 * `state.errorTag === "invalid-datasource"` branch so the
 * `useDatasourceActions` hook (which throws outside <DatasourcesProvider>)
 * is only instantiated when the explorer is rendered in a tree that
 * provides the context — i.e. the production explore route, which now
 * wraps in <DatasourcesProvider> per the page.tsx fix. Existing
 * file-explorer tests that mount <FileExplorer> in isolation never reach
 * this arm and therefore do not need to provide the context.
 *
 * Splitting `useDatasourceActions` out of the parent `FileExplorer`
 * function body is a deviation from the literal §9.7 contract wording
 * but preserves contract intent: a single shared confirm dialog per
 * arm activation, a single `actions.remove({ datasourceId })` IPC call.
 */
function InvalidDatasourceArm({
  providerId,
  datasourceId,
  onReconnectSucceeded,
  onDatasourceRemoved,
}: {
  providerId?: string;
  datasourceId: string;
  onReconnectSucceeded: () => void;
  onDatasourceRemoved?: () => void;
}) {
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const actions = useDatasourceActions();
  return (
    <>
      <InvalidDatasourceState
        providerId={providerId}
        datasourceId={datasourceId}
        onReconnectSucceeded={onReconnectSucceeded}
        onRequestRemove={() => setRemoveDialogOpen(true)}
      />
      <ConfirmRemoveDatasourceDialog
        open={removeDialogOpen}
        onCancel={() => setRemoveDialogOpen(false)}
        onConfirm={async () => {
          setRemoveDialogOpen(false);
          await actions.remove({ datasourceId });
          onDatasourceRemoved?.();
        }}
      />
    </>
  );
}

export function FileExplorer({
  datasourceId,
  providerId,
  providerKind = "s3",
  providerStatus,
  conflictResolver: conflictResolverProp,
  toaster: toasterProp,
  onDatasourceRemoved,
}: FileExplorerProps) {
  // Task 7 wiring (post-Section-9 cleanup): instantiate the production
  // shadcn-dialog-backed conflict resolver once per mount so the same
  // resolver + dialog is shared across the drop-zone and the Upload
  // dialog. Tests override via the `conflictResolver` prop.
  const { resolver: defaultConflictResolver, dialogProps: conflictDialogProps } =
    useConflictResolutionDialog();
  const conflictResolver = conflictResolverProp ?? defaultConflictResolver;
  // add-engine-rename-download §25 — instantiate the rename-conflict
  // dialog once per mount. The hook's `prompt` is wired into the store
  // via `setRenameConflictPrompt` in a `useEffect` below so a
  // `tag: "conflict"` rename envelope re-prompts before the renderer
  // surfaces an error toast. See design.md Decision 7 (renderer-wiring
  // deviation note 2026-04-28) for why rename uses a parallel dialog
  // rather than the upload component.
  const {
    prompt: renameConflictPrompt,
    dialogProps: renameConflictDialogProps,
  } = useRenameConflictDialog();
  // add-download-overwrite-confirm §6.5/§6.6 — instantiate the
  // download-conflict dialog hook once per mount. Parallel to the
  // rename hook (same component, different copy + hint metadata).
  // The prompt is registered on the store via `setDownloadConflictPrompt`
  // (mirror of the rename mount-effect below) AND threaded into the
  // download orchestrator's `downloadConflictPrompt` option so the
  // orchestrator's dispatch loop can invoke it on a `tag: "conflict"`
  // envelope. Per design.md Decision 5 the controlled component is
  // `RenameConflictDialog` (kept as-is for minimum churn); the hook's
  // `dialogProps` carries download-specific title/description and
  // optional hint metadata.
  const {
    prompt: downloadConflictPrompt,
    dialogProps: downloadConflictDialogProps,
  } = useDownloadConflictDialog();
  const router = useRouter();
  // Grab the per-datasource store directly — the module-level cache
  // ensures this is the same instance for every mount with the same id.
  // We subscribe to its state once here; child chrome components accept
  // the store prop and subscribe themselves with `useSyncExternalStore`.
  const store = getOrCreateExplorerStore(datasourceId);
  // Task 9.2 — instantiate the production Sonner-backed per-job toaster
  // once per mount so the same instance is shared between the drop-zone
  // and the upload dialog. Tests inject their own toaster via the
  // `toaster` prop and bypass this entirely. The factory is cheap, but
  // memoising keeps identity stable across re-renders so downstream
  // consumers that compare toaster references (none today, but defensive)
  // don't see spurious changes.
  //
  // Bug 2 fix: wire `onJobCompleted` to `store.retryLoad()` so a
  // completed upload triggers an immediate refetch of the current
  // folder's entries. Without this the new file is on the provider but
  // the explorer's list reflects the pre-upload snapshot until the
  // user navigates away and back. `store` is included in deps so a
  // different datasource gets a fresh toaster bound to its own store
  // (in practice the cache makes this stable per datasourceId, but the
  // dep is correct).
  const defaultToaster = useMemo(
    () => createUploadJobToaster({ onJobCompleted: () => store.retryLoad() }),
    [store],
  );
  const toaster = toasterProp ?? defaultToaster;
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  // add-engine-rename-download §25 — register the rename-conflict prompt
  // with the store so `store.rename`'s loop can re-prompt on
  // `tag: "conflict"`. Detach on unmount + on store identity change so
  // we don't leak a closed-over prompt to a stale store instance.
  useEffect(() => {
    store.setRenameConflictPrompt(renameConflictPrompt);
    return () => {
      store.setRenameConflictPrompt(null);
    };
  }, [store, renameConflictPrompt]);

  // add-download-overwrite-confirm §6.6 — register the download-conflict
  // prompt with the store. Mirrors the rename mount-effect verbatim. The
  // store keeps the prompt in a closure-private slot (not reactive
  // state); `useDownloadOrchestrator` reads the same prompt via its
  // `downloadConflictPrompt` option below so the orchestrator's
  // dispatch loop can invoke it on a `tag: "conflict"` envelope.
  useEffect(() => {
    store.setDownloadConflictPrompt(downloadConflictPrompt);
    return () => {
      store.setDownloadConflictPrompt(null);
    };
  }, [store, downloadConflictPrompt]);

  // Kick off the data-loading effect. Re-fires whenever `currentPath`
  // on the store changes; stale-response guard lives in the hook.
  useExplorerData(store, datasourceId);

  // add-engine-rename-download §24.4 — download toaster bootstrap.
  //
  // Spawn the per-job download toaster once per mount + subscribe to
  // the §18.9-§18.10 one-shot hydration channel so any in-flight
  // downloads from a prior app session (or from a sibling renderer
  // mount) get a resumed Sonner toast at the seeded progress. Live
  // `downloading` / `file-downloaded` / `download-failed` /
  // `download-cancelled` events arrive via `window.api.sync.onEvent`
  // and are routed inside the toaster's event subscription (per
  // design.md Decision 8 — the toast is decoupled from
  // `dispatchDownload`'s return value because the
  // FilesDownloadResponse contract carries only `{ savedPath, bytes }`,
  // not a `downloadJobId`).
  //
  // The toaster instance is now held in a ref so the click handler
  // (`handleDownload`) can call `toaster.registerRetry(...)` BEFORE
  // dispatching the download — that's how the failure-toast's Retry
  // button correlates back to a callable on the orchestrator (the
  // post-§24-deviation fix; see design.md Decision 8).
  //
  // The effect is defensive: it short-circuits when the preload bridge
  // is unavailable (pre-§18 test harnesses, SSR-style mounts). The
  // toaster's `dispose()` is wired into the cleanup so test mounts
  // don't leak listeners across `cleanup()`.
  const toasterRef = useRef<DownloadToaster | null>(null);
  useEffect(() => {
    const apiBridge = (
      globalThis as unknown as {
        window?: {
          api?: {
            files?: {
              onActiveDownloadsHydrate?: (
                callback: (jobs: readonly unknown[]) => void,
              ) => () => void;
            };
            sync?: { onEvent?: unknown };
          };
        };
      }
    ).window?.api;
    const hydrate = apiBridge?.files?.onActiveDownloadsHydrate;
    const syncOnEvent = apiBridge?.sync?.onEvent;
    if (typeof hydrate !== "function" || typeof syncOnEvent !== "function") {
      // Test harnesses without the §18 channel + the sync event stream
      // skip the toaster bootstrap entirely. Production always has both.
      return;
    }
    const toaster = createDownloadJobToaster();
    toasterRef.current = toaster;
    const unsubscribeHydrate = hydrate((jobs) => {
      toaster.hydrateActiveDownloads(
        jobs as Parameters<typeof toaster.hydrateActiveDownloads>[0],
      );
    });
    return () => {
      unsubscribeHydrate();
      toaster.dispose();
      toasterRef.current = null;
    };
  }, []);

  // §23/§24 follow-up — renderer download orchestrator.
  // Owns `toPath` resolution, the Save-as dialog flow, and the
  // first-run-modal queueing. The orchestrator returns the
  // FilesDownloadResponse envelope on dispatch (no `downloadJobId`),
  // and the toaster's spawn is event-driven (design.md Decision 8).
  // We register a retry callback on the toaster keyed on
  // (datasourceId, sourcePath) BEFORE every dispatch so the
  // failure-toast's Retry button can re-run the same dispatch.
  //
  // add-download-overwrite-confirm §6.6 — pass the download-conflict
  // prompt into the orchestrator's options so its dispatch loop can
  // invoke it on a `tag: "conflict"` envelope. Per advisor / Phase E
  // re-anchor: the actual conflict re-prompt loop lives in the
  // orchestrator (not in the deprecated `store.download`); the store's
  // `setDownloadConflictPrompt` registration above is preserved for
  // mount-pattern symmetry with the rename flow.
  const downloadOrchestrator = useDownloadOrchestrator({
    downloadConflictPrompt,
  });

  // Upload dialog state — opened by the toolbar Upload button (Task 6.4).
  // Dialog is controlled (not Radix-trigger-managed) so the file-explorer
  // owns both open/close AND the `initialDestination` handoff to the
  // dialog's destination tree. Reset happens inside the dialog on each
  // false → true edge (see upload-dialog.tsx).
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

  // Context-menu Download routes through the renderer download
  // orchestrator (§23) → preload `window.api.files.download`. The
  // orchestrator owns `toPath` resolution, the optional Save-as flow
  // (Shift+Click or "Always ask" preference), and the first-run-modal
  // queue. Per design.md Decision 8 the orchestrator does NOT spawn
  // the toast directly — the toaster is event-driven via
  // `window.api.sync.onEvent`. We pre-register a retry callback keyed
  // on `(datasourceId, sourcePath)` so the failure-toast's Retry
  // button can re-run this same dispatch with the original args.
  //
  // Modifier keys: the context-menu's `onDownload` plumbing is
  // `(entry) => void` (no event), so we default `shiftKey: false`
  // here. A future iteration could thread the click event through if
  // Shift+Click-from-context-menu becomes a documented affordance.
  const handleDownload = (entry: FileEntry) => {
    if (entry.kind === "directory") return;
    const retry = (): void => {
      handleDownload(entry);
    };
    toasterRef.current?.registerRetry(datasourceId, entry.path, retry);
    // add-download-resilience §12.1 / Decision 15 — single failure-toast
    // emission source. The toaster (`createDownloadJobToaster`) is the
    // SOLE emitter of `Download failed: …` toasts for in-flight failures
    // — it consumes the `download-failed` IPC event with the Retry
    // affordance attached. This dispatch caller's `.then(toast.error)`
    // was removed in iter-4 because it produced a duplicate toast (one
    // with Retry from the toaster, one without from this caller) when
    // both the response AND the event arrived for the same logical
    // failure (the §11.19 wifi-drop smoke reproduced this on Drive).
    //
    // The `.catch(toast.error)` is RETAINED — it covers the
    // categorically-different failure mode where the IPC layer itself
    // rejects (preload bridge unavailable, malformed envelope, etc.)
    // and no `download-failed` event ever flows through the bus. In
    // that case the toaster has nothing to render and this `.catch`
    // toast is the only user signal.
    //
    // Pre-job validation failures (toPath rejected, concurrent rejected,
    // resolveClient failed) return `{ ok: false, error }` from the
    // service WITHOUT emitting `download-failed`. v1 accepts that
    // those paths surface no user-visible toast — they are rare edge
    // cases (path-traversal defense, double-click guard, stale ds id);
    // console errors persist. See Decision 15 "Future tightening" for
    // the future fix pattern.
    downloadOrchestrator
      .dispatchDownload(entry, { shiftKey: false }, datasourceId)
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : "unexpected error";
        toast.error(`Download failed: ${message}`);
      });
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
            if (state.errorTag === "invalid-datasource") {
              // Pattern-A full-replace state for misconfigured datasources.
              // Reconnect lifecycle (sync.authenticateStart +
              // useAuthSession) lives inside <InvalidDatasourceState>; the
              // shared <ConfirmRemoveDatasourceDialog> + actions.remove
              // dispatch live inside <InvalidDatasourceArm> per design.md
              // Decisions 4 + 5. `onReconnectSucceeded` re-runs files:list
              // via store.retryLoad(); on success the engine resolves the
              // freshly-registered credential and the explorer naturally
              // transitions out of this branch.
              return (
                <InvalidDatasourceArm
                  providerId={providerId}
                  datasourceId={datasourceId}
                  onReconnectSucceeded={() => store.retryLoad()}
                  onDatasourceRemoved={onDatasourceRemoved}
                />
              );
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
      {/* First-run downloads modal (§21) — opens on the user's first
          ever Download click when no default folder has been
          persisted. The orchestrator queues the deferred dispatch and
          flips `modalOpen` true; the modal persists the chosen folder
          via `setDefaultFolder` and invokes `onCommit`, which the
          orchestrator wires to the queued dispatch. Once the user
          commits the folder, subsequent downloads silently use it
          (Shift+Click + Always-ask preference still gate the
          Save-as flow). */}
      <FirstDownloadModal
        open={downloadOrchestrator.modalOpen}
        onCommit={downloadOrchestrator.onModalCommit}
      />
      {/* Conflict-resolution dialog (Task 7) — Radix portal, so visual
          placement is immaterial. The hook above owns its open/close
          state; both the drop-zone and the Upload dialog share the same
          resolver so a single dialog mount suffices. */}
      <ConflictResolutionDialog {...conflictDialogProps} />
      {/* Rename-conflict dialog (add-engine-rename-download §25) — Radix
          portal. Opens only when `store.rename` hits a `tag: "conflict"`
          envelope and invokes the registered prompt. */}
      <RenameConflictDialog {...renameConflictDialogProps} />
      {/* Download-conflict dialog (add-download-overwrite-confirm §6) —
          same controlled component as the rename dialog (per design.md
          Decision 5: prop-extracted title/description + optional hint
          metadata; component name kept for minimum churn). Opens only
          when the download orchestrator's loop hits a `tag: "conflict"`
          envelope and invokes the registered prompt. */}
      <RenameConflictDialog {...downloadConflictDialogProps} />
      {/* Upload dialog, opened by the toolbar's Upload button. Default
          destination = file-explorer's currentPath (spec line 30). The
          dialog internally resets its Files list + navigation state on
          each false → true edge so reopening starts fresh. */}
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
