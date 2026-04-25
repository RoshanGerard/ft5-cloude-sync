// Collapses the engine's DatasourceError.tag vocabulary (10 variants) into
// the renderer-facing FilesErrorTag (5 variants) that the files:* command
// envelope carries. The renderer only has to branch five ways; finer
// provider tags stay inside the message.

import type { FilesErrorTag } from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

export interface FilesErrorEnvelopeInner {
  readonly tag: FilesErrorTag;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
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
              : "other";
    const base: FilesErrorEnvelopeInner = {
      tag,
      message: err.message,
      retryable: err.retryable,
    };
    if (typeof err.retryAfterMs === "number") {
      return { ...base, retryAfterMs: err.retryAfterMs };
    }
    return base;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { tag: "other", message, retryable: false };
}
