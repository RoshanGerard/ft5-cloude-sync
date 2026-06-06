// `uploads:list-active` command handler (per
// migrate-upload-orchestration-out-of-engine §10.1). Returns the
// in-memory `UploadRegistry` snapshot projected to the IPC-exposed
// `UploadJob` shape — i.e. with `abortController` stripped. The
// renderer hydrates its toaster strip from this on first
// supervisor-connect. Mirror of `downloads-list-active.ts`.
//
// The handler is read-only: never blocks on engine I/O, never touches
// the disk, never throws. The registry's `snapshot()` already orders by
// `startedAt` ascending and returns a fresh array per call, so the
// handler is a pure projection.

import type { CommandHandler } from "../ipc/server.js";

import type { UploadRegistry } from "../uploads/registry.js";

export interface UploadsListActiveDeps {
  readonly registry: UploadRegistry;
}

export function makeUploadsListActiveHandler(
  deps: UploadsListActiveDeps,
): CommandHandler<"uploads:list-active"> {
  return async () => {
    // Project internal `UploadJobEntry` (carries `abortController`) to
    // the IPC-exposed `UploadJob` (no controller). Destructuring drops
    // the controller cleanly — the rest field is structurally the wire
    // shape per the field markers on `UploadJobEntry` (registry.ts
    // doc-comment "Field `readonly` markers match the IPC type so
    // projecting one to the other in §10.1 is a structural
    // drop-the-controller").
    const jobs = deps.registry.snapshot().map((entry) => {
      const { abortController: _abort, ...job } = entry;
      return job;
    });
    return { ok: true, result: { jobs } };
  };
}
