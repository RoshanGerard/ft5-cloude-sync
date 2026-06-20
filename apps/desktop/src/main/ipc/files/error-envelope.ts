// Converts a `SyncClient.request` rejection into the renderer-facing
// FilesErrorEnvelope. Sync-service errors that extend FilesCommandErrorShape
// carry `retryable` / `retryAfterMs` on the wire (preserved on SyncCommandError's
// `.raw` field). Anything else (disconnects, timeouts, thrown Errors) collapses
// into `tag: "other"` with `retryable: false`.
//
// Tag-set evolution. The original mapper (pre-add-engine-rename-download)
// only forwarded `auth-revoked / disconnected / rate-limited / other`. As
// new tags joined `FilesErrorTag` they were added here:
//
//   - `invalid-datasource` (add-invalid-datasource-state)
//   - `conflict` + `existingPath` (add-engine-rename-download)
//   - `cancelled` + `exhausted-retries` (add-download-resilience)
//   - `existingUploadJobId` (migrate-upload-orchestration-out-of-engine
//     §13.5 — paired with the `tag: "conflict"` reply from the
//     `files:upload` concurrent-target guard, Decision 10)
//
// Unknown tags collapse to `other` so unexpected service drift doesn't
// crash the renderer.

import { FilesErrorTag } from "@ft5/ipc-contracts";
import type { FilesErrorEnvelope } from "@ft5/ipc-contracts";

import { SyncCommandError } from "../../sync/client.js";

const VALID_TAGS: ReadonlySet<FilesErrorTag> = new Set<FilesErrorTag>([
  "auth-revoked",
  "disconnected",
  "rate-limited",
  "other",
  "invalid-datasource",
  "conflict",
  "cancelled",
  "exhausted-retries",
]);

export function toFilesErrorEnvelope(err: unknown): FilesErrorEnvelope {
  if (err instanceof SyncCommandError) {
    const raw = err.raw as {
      tag?: string;
      message?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      existingPath?: string;
      existingUploadJobId?: string;
    };
    const tag: FilesErrorTag =
      typeof raw.tag === "string" && VALID_TAGS.has(raw.tag as FilesErrorTag)
        ? (raw.tag as FilesErrorTag)
        : "other";
    const envelope: FilesErrorEnvelope = {
      tag,
      message: typeof raw.message === "string" ? raw.message : err.message,
      retryable: typeof raw.retryable === "boolean" ? raw.retryable : false,
    };
    if (typeof raw.retryAfterMs === "number") {
      envelope.retryAfterMs = raw.retryAfterMs;
    }
    if (typeof raw.existingPath === "string") {
      envelope.existingPath = raw.existingPath;
    }
    if (typeof raw.existingUploadJobId === "string") {
      envelope.existingUploadJobId = raw.existingUploadJobId;
    }
    return envelope;
  }
  return {
    tag: FilesErrorTag.Other,
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}
