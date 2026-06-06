// migrate-upload-orchestration-out-of-engine §13.3 — on-supervisor-connect
// `uploads:list-active` hydrate.
//
// Mirror of `on-connect-hydrate-downloads.ts`. Behavior contract (per
// design.md Decision 4 + spec.md "App-launch hydrates active uploads
// from the service registry"):
//
//   - On the supervisor's FIRST connect of an app session, the desktop
//     main process issues exactly one `sync.request("uploads:list-active")`.
//   - The response (`{ jobs: UploadJob[] }`) is forwarded to the renderer
//     over the dedicated `files:hydrate-active-uploads` event channel.
//     The preload exposes the channel as
//     `window.api.files.onActiveUploadsHydrate(callback)`.
//   - Reconnects mid-session DO NOT re-fire. This invariant is
//     STRUCTURAL — the bootstrap call site invokes the hydrate function
//     exactly once and does NOT subscribe it to `syncHandle.on("reconnect", ...)`.
//     The function itself contains no `alreadyFired` flag; its
//     semantics are simply "issue one query + one send, every time you
//     are called." This keeps the function pure-functional and lets
//     renderer-reload scenarios (where bootstrap re-invokes it) work
//     without internal state, while the call-site guarantee in
//     `main/index.ts` is what locks fire-once-per-session.
//
// Failure mode. If the service is unreachable or returns an error, we
// log a warning and SKIP the renderer send. The renderer never sees a
// malformed snapshot; the live event feed (sync-service event bridge)
// is unaffected. The miss is bounded — only the historical snapshot of
// in-flight uploads is lost, not the live progress feed.

import type { UploadJob } from "@ft5/ipc-contracts/sync-service";

/**
 * Minimal request-able shape consumed by this module. The full
 * `SyncClient` carries an `onEvent` + `dispose` surface that the hydrate
 * never touches; narrowing the dep here makes the test injection a
 * single-method object.
 */
export interface UploadsHydrateClient {
  request(
    command: "uploads:list-active",
    params: Record<string, never>,
  ): Promise<{ jobs: readonly UploadJob[] }>;
}

/**
 * The dedicated main → renderer event channel for the one-shot snapshot.
 * Inline-string convention matches `clipboard:writeText` and
 * `files:hydrate-active-downloads` (no contract-package extension
 * required — channel names for desktop-only IPC are literals).
 */
export const ACTIVE_UPLOADS_HYDRATE_CHANNEL =
  "files:hydrate-active-uploads";

/**
 * Issue ONE `uploads:list-active` query against the supervisor's
 * current SyncClient and forward the response to the renderer over
 * `files:hydrate-active-uploads`. Resolves to `void`; never throws.
 *
 * Fire-once-per-session is the responsibility of the CALLER — invoke
 * this from `bootstrap()` after the first `startSupervisor` resolves,
 * and do NOT subscribe it to `syncHandle.on("reconnect", ...)`.
 */
export async function hydrateActiveUploadsOnce(
  client: UploadsHydrateClient,
  sendToRenderer: (
    channel: typeof ACTIVE_UPLOADS_HYDRATE_CHANNEL,
    payload: readonly UploadJob[],
  ) => void,
): Promise<void> {
  try {
    const result = await client.request("uploads:list-active", {});
    sendToRenderer(ACTIVE_UPLOADS_HYDRATE_CHANNEL, result.jobs);
  } catch (err) {
    // Best-effort: the renderer's live feed (sync-service event bridge)
    // continues to drive in-flight uploads — only the historical
    // snapshot is lost. Logging matches the prior-art idiom in
    // `event-bridge.ts` (`console.warn("[sync-event-bridge] ...", err)`).
    console.warn(
      "[on-connect-hydrate-uploads] uploads:list-active failed:",
      err,
    );
  }
}
