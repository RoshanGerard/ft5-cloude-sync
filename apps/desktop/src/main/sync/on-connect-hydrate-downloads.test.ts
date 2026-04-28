// add-engine-rename-download §18.9-§18.10 — RED tests for the on-launch
// `downloads:list-active` hydrate.
//
// Behavior (per design.md Decision 4 + spec.md "App-launch hydrates
// active downloads from the service registry"):
//   - On the supervisor's FIRST connect of an app session, the desktop
//     main process MUST issue exactly one `sync.request("downloads:list-active")`.
//   - The response MUST be forwarded to the renderer via the
//     `files:hydrate-active-downloads` channel — preload exposes this as
//     `window.api.files.onActiveDownloadsHydrate(callback)`.
//   - Reconnects mid-session MUST NOT re-fire. Fire-once-per-session is
//     a STRUCTURAL invariant: the bootstrap call site invokes the
//     hydrate function exactly once and does NOT register it on
//     `syncHandle.on("reconnect", ...)`. The function itself contains
//     no `alreadyFired` flag — its semantics are "do one query + one
//     send, every time you're called."
//
// The function takes a SyncClient-shaped object (only `request` is
// touched) and a `sendToRenderer(channel, payload)` callback so the
// caller can pass `(channel, payload) => window.webContents.send(...)`.
// Decoupling the BrowserWindow from this module keeps the test under
// plain Node and lets bootstrap pick the window at the call site.

import { describe, expect, it, vi } from "vitest";

import type { DownloadJob } from "@ft5/ipc-contracts/sync-service";

import { hydrateActiveDownloadsOnce } from "./on-connect-hydrate-downloads.js";

describe("hydrateActiveDownloadsOnce — fire-once on-supervisor-connect", () => {
  it("issues exactly one `downloads:list-active` request and forwards the jobs to the renderer on the dedicated channel", async () => {
    const sampleJobs: readonly DownloadJob[] = [
      {
        downloadJobId: "dl-1",
        datasourceId: "ds-1",
        sourcePath: "/projects/2026/welcome.pdf",
        targetPath: "/Users/alice/Downloads/ft5/welcome.pdf",
        bytesDownloaded: 12_345,
        contentLength: 100_000,
        startedAt: 1_700_000_000_000,
      },
    ];
    const request = vi.fn().mockResolvedValue({ jobs: sampleJobs });
    const sendToRenderer = vi.fn();

    await hydrateActiveDownloadsOnce({ request }, sendToRenderer);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("downloads:list-active", {});

    expect(sendToRenderer).toHaveBeenCalledTimes(1);
    expect(sendToRenderer).toHaveBeenCalledWith(
      "files:hydrate-active-downloads",
      sampleJobs,
    );
  });

  it("forwards an empty array when the registry has no active jobs (still fires exactly once)", async () => {
    const request = vi.fn().mockResolvedValue({ jobs: [] });
    const sendToRenderer = vi.fn();

    await hydrateActiveDownloadsOnce({ request }, sendToRenderer);

    expect(request).toHaveBeenCalledTimes(1);
    expect(sendToRenderer).toHaveBeenCalledTimes(1);
    expect(sendToRenderer).toHaveBeenCalledWith(
      "files:hydrate-active-downloads",
      [],
    );
  });

  it("does NOT throw when the request rejects — logs and skips the renderer send", async () => {
    // The hydrate is best-effort: if the service responds with an error
    // (e.g. service crashed mid-startup, or a transient pipe blip), the
    // renderer MUST NOT be told about a malformed snapshot. The
    // file-explorer init effect's fallback is the in-memory toaster
    // that already exists; missing the seed only loses the historical
    // snapshot, not the live event feed (which is the sync-service
    // event bridge's job).
    const request = vi.fn().mockRejectedValue(new Error("service unreachable"));
    const sendToRenderer = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      hydrateActiveDownloadsOnce({ request }, sendToRenderer),
    ).resolves.toBeUndefined();

    expect(sendToRenderer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("calling the function a second time (e.g. on a renderer reload) issues a fresh query — fire-once is a CALL-SITE invariant, not a function-level one", async () => {
    // The structural fire-once-per-session guarantee lives at the
    // bootstrap call site (which invokes this once and does NOT
    // register it on supervisor reconnect). The function itself has
    // no internal latch — calling it twice is well-defined and useful
    // for renderer-reload scenarios. Locking that here so refactors
    // toward an internal latch must explicitly break this contract.
    const sampleJobs: readonly DownloadJob[] = [];
    const request = vi.fn().mockResolvedValue({ jobs: sampleJobs });
    const sendToRenderer = vi.fn();

    await hydrateActiveDownloadsOnce({ request }, sendToRenderer);
    await hydrateActiveDownloadsOnce({ request }, sendToRenderer);

    expect(request).toHaveBeenCalledTimes(2);
    expect(sendToRenderer).toHaveBeenCalledTimes(2);
  });
});
