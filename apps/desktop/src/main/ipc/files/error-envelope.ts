// Converts a `SyncClient.request` rejection into the renderer-facing
// FilesErrorEnvelope. Sync-service errors that extend FilesCommandErrorShape
// carry `retryable` / `retryAfterMs` on the wire (preserved on SyncCommandError's
// `.raw` field). Anything else (disconnects, timeouts, thrown Errors) collapses
// into `tag: "other"` with `retryable: false`.

import type { FilesErrorEnvelope, FilesErrorTag } from "@ft5/ipc-contracts";

import { SyncCommandError } from "../../sync/client.js";

const VALID_TAGS: ReadonlySet<FilesErrorTag> = new Set<FilesErrorTag>([
  "auth-revoked",
  "disconnected",
  "rate-limited",
  "other",
]);

export function toFilesErrorEnvelope(err: unknown): FilesErrorEnvelope {
  if (err instanceof SyncCommandError) {
    const raw = err.raw as {
      tag?: string;
      message?: string;
      retryable?: boolean;
      retryAfterMs?: number;
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
      return { ...envelope, retryAfterMs: raw.retryAfterMs };
    }
    return envelope;
  }
  return {
    tag: "other",
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}
