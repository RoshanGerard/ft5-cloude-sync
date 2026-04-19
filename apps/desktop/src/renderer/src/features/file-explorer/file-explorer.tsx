"use client";

//
// FileExplorer — placeholder wrapper for Phase 2.4.
//
// This is intentionally minimal. Its only jobs today are:
//   1. Instantiate the per-datasource store (`useExplorerStore(datasourceId)`)
//      so that later phases can observe the store already wired at the route
//      mount point.
//   2. Render a recognizable anchor (`data-testid="file-explorer-root"`) that
//      subsequent chrome tasks (breadcrumb, back/forward/up, toolbar, view
//      modes, details pane) can hang their elements off without re-running
//      the route-level tests.
//
// The placeholder content — "Explorer for <datasourceId>" — will be replaced
// as Phases 2.6 → 3.x → 5 → 6 → 7 build out the real chrome. The data-testid
// is the stable contract; the text content is free to change.

import { useExplorerStore } from "./store";

export interface FileExplorerProps {
  datasourceId: string;
}

export function FileExplorer({ datasourceId }: FileExplorerProps) {
  // Instantiate the store for this datasource id. The returned state will be
  // consumed by the chrome components as they land in subsequent tasks; for
  // now we touch the hook so the factory closure is created and the
  // module-level cache picks it up (so tests asserting store existence post
  // render-mount see a hit, not a miss).
  useExplorerStore(datasourceId);

  return (
    <div
      data-testid="file-explorer-root"
      className="flex h-full flex-col p-4 text-sm text-muted-foreground"
    >
      Explorer for {datasourceId}
    </div>
  );
}
