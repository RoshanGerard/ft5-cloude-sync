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

import { useSyncExternalStore } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { Breadcrumb } from "./breadcrumb";
import { HistoryButtons } from "./history-buttons";
import { getOrCreateExplorerStore } from "./store";
import { StatusRow } from "./status-row";
import { Toolbar } from "./toolbar";
import { useExplorerData } from "./use-explorer-data";
import { useKeyboardNav } from "./use-keyboard-nav";
import { ViewModeSwitcher } from "./view-mode-switcher";

export interface FileExplorerProps {
  datasourceId: string;
}

export function FileExplorer({ datasourceId }: FileExplorerProps) {
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
    // Rename / delete real wiring lands in Phase 6; keep the callbacks
    // as no-ops so the keyboard shortcuts don't throw in v1.
    onRenameRequested: () => {},
    onDeleteRequested: () => {},
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
  // Phase 5 / Phase 6 wire these to Properties modal / rename / delete
  // / download actions respectively. Kept as no-ops here so the
  // composite stays green while those phases land.
  const handleNoop = () => {};

  return (
    <div
      data-testid="file-explorer-root"
      className="bg-background flex h-full flex-col"
    >
      {/* Chrome row: history buttons + breadcrumb + toolbar. */}
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <HistoryButtons store={store} />
        <div className="min-w-0 flex-1">
          <Breadcrumb store={store} />
        </div>
        <Toolbar store={store} />
      </div>

      {/* Main pane: loading / error / populated states. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {state.loading ? (
          <div
            data-testid="file-explorer-loading"
            className="text-muted-foreground p-4 text-sm"
          >
            Loading…
          </div>
        ) : state.error !== null ? (
          <div
            data-testid="file-explorer-error"
            role="alert"
            className="text-destructive p-4 text-sm"
          >
            Failed to load: {state.error}
          </div>
        ) : (
          <ViewModeSwitcher
            store={store}
            keyboardNav={keyboardNav}
            onOpen={handleOpen}
            onDownload={handleNoop}
            onRename={handleNoop}
            onDelete={handleNoop}
            onCopyPath={handleCopyPath}
            onProperties={handleNoop}
          />
        )}
      </div>

      {/* Status row pinned to bottom. */}
      <StatusRow store={store} />
    </div>
  );
}
