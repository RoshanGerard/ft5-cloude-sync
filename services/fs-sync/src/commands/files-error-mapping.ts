// Collapses the engine's DatasourceError.tag vocabulary (10 variants) into
// the renderer-facing FilesErrorTag (6 variants) that the files:* command
// envelope carries. The renderer only has to branch six ways; finer
// provider tags stay inside the message.
//
// The 6 surface tags are: "auth-revoked", "disconnected", "rate-limited",
// "other", "invalid-datasource", "conflict". The latter (added by
// add-engine-rename-download Decision 7) threads `raw.existingPath` from
// the engine's `DatasourceError` onto the envelope's `existingPath`
// field so the renderer's ConflictResolutionDialog can prompt with the
// colliding sibling path.

import type { FilesErrorTag } from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

export interface FilesErrorEnvelopeInner {
  readonly tag: FilesErrorTag;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly existingPath?: string;
}

// Defensive extractor for `DatasourceError.raw.existingPath`. The engine
// strategies put `raw: { existingPath }` on conflict-tagged errors (per
// design.md Decision 7), but `raw` is typed `unknown` so we shape-check
// before reading. A non-string or missing field returns undefined and
// the wire envelope omits the field.
function readExistingPath(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const candidate = (raw as Record<string, unknown>).existingPath;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Normalize any thrown value into the FilesErrorEnvelope inner shape.
 * DatasourceError instances map deterministically by their `.tag`; anything
 * else becomes `tag: "other"` with the raw message.
 */
export function normalizeFilesError(err: unknown): FilesErrorEnvelopeInner {
  if (err instanceof DatasourceError) {
    const tag: FilesErrorTag =
      err.tag === "auth-revoked" || err.tag === "auth-expired"
        ? "auth-revoked"
        : err.tag === "network-error"
          ? "disconnected"
          : err.tag === "rate-limited"
            ? "rate-limited"
            : err.tag === "invalid-datasource"
              ? "invalid-datasource"
              : err.tag === "conflict"
                ? "conflict"
                : "other";
    const base: FilesErrorEnvelopeInner = {
      tag,
      message: err.message,
      retryable: err.retryable,
    };
    let result: FilesErrorEnvelopeInner = base;
    if (typeof err.retryAfterMs === "number") {
      result = { ...result, retryAfterMs: err.retryAfterMs };
    }
    if (tag === "conflict") {
      const existingPath = readExistingPath(err.raw);
      if (existingPath !== undefined) {
        result = { ...result, existingPath };
      }
    }
    return result;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { tag: "other", message, retryable: false };
}
