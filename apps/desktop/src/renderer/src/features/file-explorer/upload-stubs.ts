"use client";

//
// Upload-orchestrator port stub for the conflict resolver.
//
// The drop-zone (Task 5) and upload-dialog (Task 6) both instantiate
// `createUploadOrchestrator`, which requires a `conflictResolver`. The
// production resolver (Task 7's `useConflictResolutionDialog`) is
// hook-shaped and lives at the dialog call site; this module-scope stub
// is the no-resolver fallback used until that wiring step lands. It
// emits a "coming soon" toast and aborts the batch so silent overwrites
// can't happen.
//
// Kept module-scope (no React state) so every caller gets the same
// object identity. Drop-zone / upload-dialog props allow overrides so
// tests and the eventual real wiring can swap it in.

import { toast } from "sonner";

import type { ConflictResolver } from "./use-upload-orchestrator.js";

export const STUB_CONFLICT_RESOLVER: ConflictResolver = {
  async resolve() {
    toast.error("Conflict resolution coming soon");
    // Abort the batch so we don't silently overwrite until Task 7 lands.
    return { aborted: true };
  },
};
