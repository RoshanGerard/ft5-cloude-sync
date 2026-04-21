// Phase 10 (tasks 10.6 + 10.7) — renderer-side typed React hook over
// `window.api.datasources.onEvent`.
//
// `useDatasourceEvents(cb)` is a tiny wrapper around the preload subscription:
// it registers exactly one IPC listener per mounted hook instance, forwards
// every engine event to the caller's callback, and disposes on unmount.
//
// Design notes:
//
//   - The hook captures the latest `cb` in a ref and has an empty effect-deps
//     list for the subscription effect. This keeps the listener count equal
//     to the mounted-hook count (not the render count) and spares callers
//     from memoising their callback to avoid subscription churn. Callers who
//     change behaviour based on external state do so inside their callback —
//     the ref always points at the freshest closure.
//
//   - The callback parameter is typed as `AnyDatasourceEvent`. Consumers
//     narrow via `switch (event.datasourceType)` (and optionally
//     `switch (event.event)`); the `DatasourceEvent<T, K>` generic guarantees
//     payload-shape narrowing flows through both discriminators.
//
//   - No `useCallback`/`useMemo` is required inside the hook. The effect
//     reads `ref.current` at call-time, so the subscription does not need to
//     be torn down/rebuilt when `cb` changes.
//
// Refs: openspec/changes/add-fs-datasource-engine/tasks.md 10.6 + 10.7.

import { useEffect, useRef } from "react";

import type { AnyDatasourceEvent } from "@ft5/ipc-contracts";

/**
 * Subscribe to the FS Datasource Engine event stream for the lifetime of the
 * calling component. `cb` is invoked for EVERY event the engine emits —
 * callers narrow via `switch (event.datasourceType)` (and then
 * `switch (event.event)`) inside the callback.
 *
 * The hook captures the latest `cb` via a ref so subscribers don't need to
 * memoize their callback for correctness. The preload subscription itself is
 * stable across renders and only torn down on unmount — this keeps the IPC
 * listener count equal to the mounted-hook count, not the render count.
 */
export function useDatasourceEvents(
  cb: (event: AnyDatasourceEvent) => void,
): void {
  // Keep the latest `cb` in a ref so the subscription effect's dep list can
  // be empty. Updating the ref in an effect (not during render) keeps the
  // render phase pure and matches React's recommended pattern for
  // "latest value" captures.
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  });

  useEffect(() => {
    const unsubscribe = window.api.datasources.onEvent((event) => {
      cbRef.current(event);
    });
    return unsubscribe;
  }, []);
}
