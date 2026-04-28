// `downloads:list-active` command handler (per add-engine-rename-download
// §14). Returns the in-memory `DownloadRegistry` snapshot projected to
// the IPC-exposed `DownloadJob` shape — i.e. with `abortController`
// stripped. The renderer hydrates its toaster strip from this on first
// supervisor-connect.
//
// The handler is read-only: never blocks on engine I/O, never touches
// the disk, never throws. The registry's `snapshot()` already orders by
// `startedAt` ascending and returns a fresh array per call, so the
// handler is a pure projection.
//
// See:
// - openspec/changes/add-engine-rename-download/design.md "Decision 4"
//   (DownloadRegistry + downloads:list-active hydration use case).
// - openspec/changes/add-engine-rename-download/specs/fs-sync-service/spec.md
//   "Requirement: `downloads:list-active` RPC returns the registry snapshot"
//   + scenarios "Empty registry" / "Two in-flight downloads".

import type { CommandHandler } from "../ipc/server.js";

import type { DownloadRegistry } from "../downloads/registry.js";

export interface DownloadsListActiveDeps {
  readonly registry: DownloadRegistry;
}

export function makeDownloadsListActiveHandler(
  deps: DownloadsListActiveDeps,
): CommandHandler<"downloads:list-active"> {
  return async () => {
    // Project internal `DownloadJobEntry` (carries `abortController`) to
    // the IPC-exposed `DownloadJob` (no controller). Destructuring drops
    // the controller cleanly — the rest field is structurally the wire
    // shape per the field markers on `DownloadJobEntry` (registry.ts
    // doc-comment "Field `readonly` markers match the IPC type so
    // projecting one to the other in §14 is a structural
    // drop-the-controller").
    const jobs = deps.registry.snapshot().map((entry) => {
      const { abortController: _abort, ...job } = entry;
      return job;
    });
    return { ok: true, result: { jobs } };
  };
}
