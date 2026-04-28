// add-engine-rename-download §18.9-§18.10 — on-supervisor-connect
// `downloads:list-active` hydrate.
//
// Behavior contract (design.md Decision 4 + spec.md "App-launch hydrates
// active downloads from the service registry"):
//
//   - On the supervisor's FIRST connect of an app session, the desktop
//     main process issues exactly one `sync.request("downloads:list-active")`.
//   - The response (`{ jobs: DownloadJob[] }`) is forwarded to the
//     renderer over the dedicated `files:hydrate-active-downloads`
//     event channel. The preload exposes the channel as
//     `window.api.files.onActiveDownloadsHydrate(callback)`.
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
// The function takes a request-able client + a `sendToRenderer`
// callback so the caller can inject `(channel, payload) =>
// window.webContents.send(channel, payload)` and the test suite can
// assert against a `vi.fn()` without mounting a BrowserWindow. Same
// shape principle as the rest of `main/sync/`: pure-functional core,
// Electron-aware glue at the registration site.
//
// Failure mode. If the service is unreachable or returns an error, we
// log a warning and SKIP the renderer send. The renderer never sees a
// malformed snapshot; the live event feed (sync-service event bridge)
// is unaffected. The miss is bounded — only the historical snapshot of
// in-flight downloads is lost, not the live progress feed.

import type { DownloadJob } from "@ft5/ipc-contracts/sync-service";

/**
 * Minimal request-able shape consumed by this module. The full
 * `SyncClient` carries an `onEvent` + `dispose` surface that the hydrate
 * never touches; narrowing the dep here makes the test injection a
 * single-method object.
 */
export interface DownloadsHydrateClient {
  request(
    command: "downloads:list-active",
    params: Record<string, never>,
  ): Promise<{ jobs: readonly DownloadJob[] }>;
}

/**
 * The dedicated main → renderer event channel for the one-shot snapshot.
 * Inline-string convention matches `clipboard:writeText` and
 * `files:openSavedPath` (no contract-package extension required —
 * channel names for desktop-only IPC are literals).
 */
export const ACTIVE_DOWNLOADS_HYDRATE_CHANNEL =
  "files:hydrate-active-downloads";

/**
 * Issue ONE `downloads:list-active` query against the supervisor's
 * current SyncClient and forward the response to the renderer over
 * `files:hydrate-active-downloads`. Resolves to `void`; never throws.
 *
 * Fire-once-per-session is the responsibility of the CALLER — invoke
 * this from `bootstrap()` after the first `startSupervisor` resolves,
 * and do NOT subscribe it to `syncHandle.on("reconnect", ...)`.
 */
export async function hydrateActiveDownloadsOnce(
  client: DownloadsHydrateClient,
  sendToRenderer: (
    channel: typeof ACTIVE_DOWNLOADS_HYDRATE_CHANNEL,
    payload: readonly DownloadJob[],
  ) => void,
): Promise<void> {
  try {
    const result = await client.request("downloads:list-active", {});
    sendToRenderer(ACTIVE_DOWNLOADS_HYDRATE_CHANNEL, result.jobs);
  } catch (err) {
    // Best-effort: the renderer's live feed (sync-service event bridge)
    // continues to drive in-flight downloads — only the historical
    // snapshot is lost. Logging matches the prior-art idiom in
    // `event-bridge.ts` (`console.warn("[sync-event-bridge] ...", err)`).
    console.warn(
      "[on-connect-hydrate-downloads] downloads:list-active failed:",
      err,
    );
  }
}
