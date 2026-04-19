"use client";

import { useEffect, useRef } from "react";
import { useSyncExternalStore } from "react";

import type { ExplorerStore } from "./store.js";

/**
 * `useExplorerData` — the composite-only data-loading hook for the
 * file-explorer. Reads `currentPath` from the passed-in store and
 * dispatches `window.api.files.list({ datasourceId, path })` whenever
 * the path changes. Updates the store's `loading` / `error` / `entries`
 * slots so every view mode and the status row see consistent state.
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

    let cancelled = false;

    void window.api.files
      .list({ datasourceId, path: state.currentPath })
      .then((response) => {
        if (cancelled) return;
        // Stale-response guard: only apply if we are the most recent
        // dispatch. If the user navigated mid-flight, requestIdRef.current
        // has already moved past `requestId`.
        if (requestIdRef.current !== requestId) return;
        store.setEntries(response.entries);
        store.setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (requestIdRef.current !== requestId) return;
        const message =
          error instanceof Error ? error.message : String(error);
        store.setError(message);
        store.setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [store, datasourceId, state.currentPath]);
}
