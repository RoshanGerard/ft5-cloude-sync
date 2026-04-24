"use client";

//
// Upload-orchestrator port stubs.
//
// The drop-zone (Task 5) and upload-dialog (Task 6) both instantiate
// `createUploadOrchestrator`, which requires a `conflictResolver` and a
// `toaster`. Tasks 7 and 9 will wire the real shadcn-backed conflict
// dialog and the real Sonner-per-job toaster. Until then we share these
// stubs across BOTH entry points so behaviour is uniform — a conflict
// from a drag-drop and a conflict from the Upload dialog surface the
// same "coming soon" toast, and a dispatched job from either path
// raises the same informational toast.
//
// Kept module-scope (no React state) so every caller gets the same
// object identity. The drop-zone props allow overrides so tests and
// future real wirings can swap them in.

import { toast } from "sonner";

import type {
  ConflictResolver,
  UploadToaster,
} from "./use-upload-orchestrator.js";

export const STUB_CONFLICT_RESOLVER: ConflictResolver = {
  async resolve() {
    toast.error("Conflict resolution coming soon");
    // Abort the batch so we don't silently overwrite until Task 7 lands.
    return { aborted: true };
  },
};

export const STUB_TOASTER: UploadToaster = {
  onJobDispatched(args) {
    toast.info(`Upload queued: ${args.basename}`);
  },
  onBatchError(message) {
    toast.error(message);
  },
};
