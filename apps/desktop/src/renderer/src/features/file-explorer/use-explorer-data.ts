"use client";

import { useEffect, useRef } from "react";
import { useSyncExternalStore } from "react";

import { readExplorerPageSize } from "./store";
import type { ExplorerStore } from "./store";

/**
 * `useExplorerData` — the composite-only data-loading hook for the
 * file-explorer. Reads `currentPath` from the passed-in store and
 * dispatches `window.api.files.list({ datasourceId, path, pageSize })`
 * whenever the path changes. Updates the store's `loading` / `error` /
 * `entries` / `nextCursor` slots so every view mode, the status row, and
 * the Load-more affordance see consistent state.
 *
 * Pagination (add-engine-listdirectory-pagination §8.7): the initial list
 * is ALSO a list-call origination, so it reads `pageSize` from localStorage
 * via the same `readExplorerPageSize()` the store's `loadMore` uses, and
 * routes the success payload through `store.applyInitialPage` to seed
 * `nextCursor` (the "Load more" visibility signal). On `ok:false` the
 * existing full-screen error path is unchanged — a FIRST-page failure is a
 * full-listing failure, distinct from `loadMore`'s page-load-failed row.
 *
 * Request-ordering guarantee: each dispatch bumps a monotonic request id
 * stored on a ref; when a response resolves, we drop it on the floor if
 * the request id has moved on. This is the "navigate mid-flight"
 * scenario: the user clicks into `/photos` while the root `/` list is
 * still resolving; we must not overwrite the `/photos` entries with the
 * stale `/` entries when the slower call eventually resolves.
 *
 * Scope: this hook is ONLY consumed by the composite `FileExplorer`. View
 * modes and tests that mount a view mode directly drive the store via
 * `store.setEntries(...)` in `act(() => { ... })` and do not need this
 * hook.
 */
export function useExplorerData(
  store: ExplorerStore,
  datasourceId: string,
): void {
  // Subscribe to the store so currentPath changes trigger an effect run.
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    store.setLoading(true);
    store.setError(null);
    store.setErrorTag(null);

    let cancelled = false;

    void window.api.files
      .list({
        datasourceId,
        path: state.currentPath,
        pageSize: readExplorerPageSize(),
      })
      .then((response) => {
        if (cancelled) return;
        // Stale-response guard: only apply if we are the most recent
        // dispatch. If the user navigated mid-flight, requestIdRef.current
        // has already moved past `requestId`.
        if (requestIdRef.current !== requestId) return;
        if (response.ok) {
          // Seed entries AND nextCursor together so the Load-more
          // affordance knows whether more pages exist (§8.7).
          store.applyInitialPage(response.value);
          store.setLoading(false);
        } else {
          store.setError(response.error.message);
          store.setErrorTag(response.error.tag);
          store.setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (requestIdRef.current !== requestId) return;
        const message =
          error instanceof Error ? error.message : String(error);
        store.setError(message);
        // Thrown errors (e.g. ipcRenderer reject) don't carry a tag; treat
        // as "other" so the UI falls back to the generic error surface
        // rather than one of the tagged state components.
        store.setErrorTag("other");
        store.setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `refetchToken` is included so `store.retryLoad()` re-runs the effect
    // even when `currentPath` has not changed.
  }, [store, datasourceId, state.currentPath, state.refetchToken]);
}
