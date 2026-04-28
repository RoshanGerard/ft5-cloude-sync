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

// Post-archive smoke (2026-04-28): defence-in-depth for Google Drive's
// "fileNotDownloadable" 403, surfaced when the user attempted to
// download a Google Doc. The strategy now detects Google Apps mimes
// upstream and refuses with a friendly `tag: "unsupported"` message
// (per `add-drive-docs-editors-export` parking note) — but if a future
// vendor adds a new `application/vnd.google-apps.<subtype>` we don't
// recognise, the fallback path lets the alt=media call hit the API
// and the SDK normalizes to `tag: "provider-error"` carrying the raw
// 403 JSON in the message. That JSON includes `"fileNotDownloadable"`
// (the documented Google reason) and the user-hostile Drive prose
// `"Use Export with Docs Editors files"`. Either signature triggers
// the friendly substitution below.
const DRIVE_NOT_DOWNLOADABLE_REASON = "fileNotDownloadable";
const DRIVE_DOCS_EDITORS_PHRASE = "Use Export with Docs Editors files";
// Post-smoke-2 (2026-04-28): user wants a single concise line in the
// toast — not the per-subtype prose the strategy used to ship. The
// parked follow-up `add-drive-docs-editors-export` still owns the
// proper export path; this is just the friendly refusal.
const FRIENDLY_DOCS_EDITORS_MESSAGE =
  "Google Drive documents download not supported";

function looksLikeDriveDocsEditorsRefusal(message: string): boolean {
  return (
    message.includes(DRIVE_NOT_DOWNLOADABLE_REASON) ||
    message.includes(DRIVE_DOCS_EDITORS_PHRASE)
  );
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
    // Substitute the Drive Docs-Editors raw 403 JSON with a friendly
    // message — defence-in-depth fallback when the engine's upstream
    // Google Apps detection misses (e.g. a future Google subtype). The
    // tag stays whatever the engine produced (typically collapses to
    // "other"); only the message is rewritten.
    const message = looksLikeDriveDocsEditorsRefusal(err.message)
      ? FRIENDLY_DOCS_EDITORS_MESSAGE
      : err.message;
    const base: FilesErrorEnvelopeInner = {
      tag,
      message,
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
  const rawMessage = err instanceof Error ? err.message : String(err);
  // Same defence-in-depth substitution for non-DatasourceError throws
  // that happen to embed the Drive Docs-Editors signature.
  const message = looksLikeDriveDocsEditorsRefusal(rawMessage)
    ? FRIENDLY_DOCS_EDITORS_MESSAGE
    : rawMessage;
  return { tag: "other", message, retryable: false };
}
