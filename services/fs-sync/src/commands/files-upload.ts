// `files:upload` command handler — fs-sync's business-logic orchestration
// for the engine's `uploadFile` primitive (per
// migrate-upload-orchestration-out-of-engine §9 + design.md Decision 5 +
// spec.md "Requirement: `files:upload` direct RPC handler"). The handler:
//
// 1. Validates `sourcePath` (absolute) and `targetPath` (syntactically
//    valid). Reject with `tag: "other"` on validation failure.
// 2. Rejects a second upload to the same `(datasourceId, targetPath)`
//    BEFORE minting a job id (concurrent-target rejection guard,
//    Decision 10).
// 3. Mints an `uploadJobId` UUID + creates an AbortController.
// 4. Inserts a registry entry (the registry's reverse-index is updated
//    in lockstep so `findByTarget` resolves immediately).
// 5. Resolves the engine client.
// 6. Emits the initial `uploading` 0% event so the renderer sees the
//    upload start before the engine begins streaming.
// 7. Calls `client.uploadFile(parent, file, { signal, onProgress })`.
// 8. The `onProgress` callback updates the registry and emits
//    throttled `uploading` events (1s elapsed OR 10% delta). Always
//    emits the FINAL 100% tick unthrottled.
// 9. On engine resolve: emits `file-created`, deletes registry, replies
//    `{ ok: true, result: { uploadJobId } }`.
// 10. On engine reject `tag === "cancelled"`: emits `upload-cancelled`,
//     deletes registry, replies cancelled envelope.
// 11. On engine reject other tag: emits `upload-failed`, deletes
//     registry, replies normalized error envelope.
//
// The handler is much simpler than `files-download.ts`. There is NO
// retry loop, NO resume / range, NO integrity check, NO disposition
// policy: just engine call + event emission. Cancel is signal-driven
// (the engine no longer has a `cancelUpload` method).

import { randomUUID as nodeRandomUUID } from "node:crypto";
import * as nodePosixPath from "node:path/posix";
import * as nodePath from "node:path";

import type {
  DatasourceClient,
  Target,
} from "@ft5/fs-datasource-engine";
import { withAuthRefresh } from "@ft5/fs-datasource-engine";
import type { DatasourceType } from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";

import type { CommandHandler } from "../ipc/server.js";
import type { EventBus } from "../events/event-bus.js";
import type {
  UploadRegistry,
  UploadJobEntry,
} from "../uploads/registry.js";

import { normalizeFilesError } from "./files-error-mapping.js";

// ---------------------------------------------------------------------------
// Throttle policy (per design.md Decision 5).
// ---------------------------------------------------------------------------

/** Emit at most once per second, OR whenever the percent-delta crosses
 * 10pp. The initial 0% and final 100% are emitted unthrottled by the
 * call sites that wrap this function. */
const THROTTLE_TIME_MS = 1_000;
const THROTTLE_PCT_DELTA = 10;

// ---------------------------------------------------------------------------
// Handler dependency surface
// ---------------------------------------------------------------------------

export interface FilesUploadDeps {
  readonly resolveClient: (
    datasourceId: string,
  ) => Promise<DatasourceClient<DatasourceType>>;
  readonly registry: UploadRegistry;
  readonly fsSyncBus: EventBus;
  readonly randomUUID: () => string;
  readonly now: () => number;
}

/**
 * Default dependency bundle — wraps `node:crypto.randomUUID` and
 * `Date.now`. Tests build their own deps from in-memory fakes.
 */
export function createDefaultFilesUploadDeps(deps: {
  resolveClient: FilesUploadDeps["resolveClient"];
  registry: UploadRegistry;
  fsSyncBus: EventBus;
}): FilesUploadDeps {
  return {
    ...deps,
    randomUUID: () => nodeRandomUUID(),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Sentinel error class — internal to this module. Disambiguates the
// cancel branch in the terminal catch from real engine errors.
// ---------------------------------------------------------------------------

class CancelledError extends Error {
  constructor() {
    super("upload cancelled");
    this.name = "CancelledError";
  }
}

// ---------------------------------------------------------------------------
// Validation — sourcePath must be absolute (local-OS path), targetPath
// must be a valid posix path with a non-empty filename. The validators
// are deliberately minimal: cross-platform path normalization details
// (Windows drive letters, UNC paths) are deferred to the OS-level FS
// boundary inside the strategy, not the handler.
// ---------------------------------------------------------------------------

interface ValidationFailure {
  readonly ok: false;
  readonly reason: string;
}
interface ValidationSuccess {
  readonly ok: true;
  readonly parentPath: string;
  readonly fileName: string;
}
type ValidationResult = ValidationFailure | ValidationSuccess;

function validateUploadPaths(
  sourcePath: string,
  targetPath: string,
): ValidationResult {
  // Source is a local-OS path — use platform `path.isAbsolute` for the
  // check (so `C:\foo\bar.jpg` passes on Windows and `/foo/bar.jpg`
  // passes on Unix; relative `foo/bar.jpg` fails on both).
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    return { ok: false, reason: "sourcePath must be a non-empty string" };
  }
  if (!nodePath.isAbsolute(sourcePath)) {
    return { ok: false, reason: "sourcePath must be an absolute path" };
  }
  // Target is a posix datasource path — use posix.isAbsolute (always
  // expects leading `/`). Decompose into parent + name; reject empty
  // basename (e.g. trailing-slash `/photos/`).
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    return { ok: false, reason: "targetPath must be a non-empty string" };
  }
  if (!nodePosixPath.isAbsolute(targetPath)) {
    return { ok: false, reason: "targetPath must be an absolute posix path" };
  }
  // Trailing slash means the user supplied a directory path with no
  // filename — `posix.basename("/photos/")` strips the trailing slash
  // and returns `"photos"`, hiding the missing filename. Catch it
  // explicitly here.
  if (targetPath.endsWith("/")) {
    return {
      ok: false,
      reason: "targetPath must include a non-empty filename",
    };
  }
  const parentPath = nodePosixPath.dirname(targetPath);
  const fileName = nodePosixPath.basename(targetPath);
  if (fileName === "" || fileName === "/" || fileName === ".") {
    return {
      ok: false,
      reason: "targetPath must include a non-empty filename",
    };
  }
  return { ok: true, parentPath, fileName };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function makeFilesUploadHandler(
  deps: FilesUploadDeps,
): CommandHandler<"files:upload"> {
  return async (params) => {
    // 1. Validation — synchronous; on failure short-circuit with
    //    `tag: "other"` per spec.
    const validation = validateUploadPaths(params.sourcePath, params.targetPath);
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          tag: "other",
          message: `validation: ${validation.reason}`,
          retryable: false,
        },
      };
    }

    // 2. Concurrent-target rejection guard (Decision 10). Reject the
    //    SECOND request to an in-flight `(datasourceId, targetPath)`
    //    BEFORE resolving the client / minting a job id / opening any
    //    provider request. The error envelope carries
    //    `existingUploadJobId` (the in-flight job's id) and
    //    `existingPath` (the disputed targetPath) so the renderer's
    //    Sonner toast can point the user at the existing toast.
    const existingUploadJobId = deps.registry.findByTarget(
      params.datasourceId,
      params.targetPath,
    );
    if (existingUploadJobId !== undefined) {
      return {
        ok: false,
        error: {
          tag: "conflict",
          message:
            "An upload to this path is already in progress",
          retryable: false,
          existingUploadJobId,
          existingPath: params.targetPath,
        },
      };
    }

    // 3. Resolve client. Failure (e.g. unknown datasourceId) maps via
    //    the existing normalizeFilesError convention. We resolve BEFORE
    //    minting the job so a resolveClient failure doesn't leak a
    //    registry entry.
    let client: DatasourceClient<DatasourceType>;
    try {
      client = await deps.resolveClient(params.datasourceId);
    } catch (err) {
      return { ok: false, error: normalizeFilesError(err) };
    }

    // 4. Mint job + create AbortController + insert registry entry.
    const uploadJobId = deps.randomUUID();
    const abortController = new AbortController();
    const startedAt = deps.now();
    const initialEntry: UploadJobEntry = {
      uploadJobId,
      datasourceId: params.datasourceId,
      sourcePath: params.sourcePath,
      targetPath: params.targetPath,
      bytesUploaded: 0,
      contentLength: null,
      startedAt,
      abortController,
    };
    deps.registry.set(initialEntry);

    // 5. Throttle state — closure-scoped so the onProgress callback
    //    can read/update them between ticks. The initial 0% emission
    //    seeds `lastEmittedAtMs` and `lastEmittedPct` so the throttle
    //    treats it as the seed for the next tick's threshold check.
    let lastEmittedAtMs = startedAt;
    let lastEmittedPct = 0;

    function emitUploading(
      bytesUploaded: number,
      bytesTotal: number | null,
      force: boolean,
    ): void {
      deps.fsSyncBus.emit("uploading", {
        uploadJobId,
        datasourceId: params.datasourceId,
        sourcePath: params.sourcePath,
        targetPath: params.targetPath,
        bytesUploaded,
        bytesTotal,
      });
      lastEmittedAtMs = deps.now();
      if (bytesTotal !== null && bytesTotal > 0) {
        lastEmittedPct = Math.floor((bytesUploaded / bytesTotal) * 100);
      } else if (force) {
        // No total advertised; the renderer's bytes-only fallback runs.
        // Reset the percent gate to 0 on force so the next force-emit
        // (final 100%) still looks like a delta.
        lastEmittedPct = 0;
      }
    }

    // 6. Emit the initial 0% `uploading` event so the renderer's toast
    //    shows the upload starting BEFORE the engine begins streaming.
    //    Always unthrottled.
    emitUploading(0, null, true);

    // 7. Decompose targetPath into engine `parent` Target + filename.
    //    The engine's `uploadFile(parent, file, options)` takes the
    //    parent directory as a Target, not the full destination path.
    const parent: Target = { kind: "path", path: validation.parentPath };
    const file = {
      path: params.sourcePath,
      name: validation.fileName,
    };

    // 8. onProgress callback — updates the registry and emits throttled
    //    `uploading` events. The callback runs synchronously inside the
    //    engine's per-chunk hook; it must not throw or the engine's
    //    upload will surface a spurious error.
    const onProgress = (loaded: number, total: number): void => {
      try {
        deps.registry.update(uploadJobId, {
          bytesUploaded: loaded,
          contentLength: total,
        });
        // Throttle: emit if the last emit was >= 1s ago OR the
        // percent-delta from the last emit is >= 10pp. Always emit the
        // final 100% tick unthrottled.
        const now = deps.now();
        const timeOk = now - lastEmittedAtMs >= THROTTLE_TIME_MS;
        const pct =
          total > 0 ? Math.floor((loaded / total) * 100) : 0;
        const pctOk = Math.abs(pct - lastEmittedPct) >= THROTTLE_PCT_DELTA;
        const isFinal = total > 0 && loaded >= total;
        if (timeOk || pctOk || isFinal) {
          emitUploading(loaded, total, isFinal);
        }
      } catch {
        // Defensive — never let the throttle/emission path break the
        // engine's progress callback.
      }
    };

    // 9. Run the engine call + branch on outcome.
    //
    // migrate-engine-retry-policy-to-consumer Decision 4 — the engine no
    // longer auto-refreshes on `auth-expired`; the handler owns the policy
    // via `withAuthRefresh` (refresh once, retry once). Because this is a
    // single engine call, the wrap reproduces the engine's prior
    // refresh-and-retry byte-for-byte — the retry re-uploads the whole file,
    // identical to today. A second `auth-expired` after the refresh
    // propagates into the catch below and normalizes to `auth-revoked`.
    let entry: { handle: string };
    try {
      entry = await withAuthRefresh(client, () =>
        client.uploadFile(parent, file, {
          signal: abortController.signal,
          onProgress,
        }),
      );
    } catch (err) {
      // Branch on cancel vs other failure. Use the AbortController's
      // own state as the authoritative cancel signal — a `tag:
      // "cancelled"` engine error AFTER user-cancel routes through the
      // same branch as a strategy that rejects with cancelled
      // synchronously upon abort.
      const isCancel =
        abortController.signal.aborted ||
        (err instanceof DatasourceError && err.tag === "cancelled") ||
        err instanceof CancelledError;
      const last = deps.registry.get(uploadJobId);
      const bytesUploaded = last?.bytesUploaded ?? 0;
      const bytesTotal = last?.contentLength ?? null;

      // Clear registry BEFORE emitting so a subscriber that calls back
      // into list-active sees the post-terminal state.
      deps.registry.delete(uploadJobId);

      if (isCancel) {
        deps.fsSyncBus.emit("upload-cancelled", {
          uploadJobId,
          datasourceId: params.datasourceId,
          sourcePath: params.sourcePath,
          targetPath: params.targetPath,
          bytesUploaded,
          bytesTotal,
          reason: "user",
        });
        return {
          ok: false,
          error: {
            tag: "cancelled",
            message: "upload cancelled",
            retryable: false,
          },
        };
      }

      // Other failure — normalize and emit upload-failed.
      const norm = normalizeFilesError(err);
      // The upload-failed event tag union excludes `cancelled` and
      // `conflict` (cancelled is its own event; conflict is a synchronous
      // reply). Collapse those two onto `other` defensively — neither
      // should reach this branch in practice (conflict is rejected
      // BEFORE the engine call; cancelled routes through `isCancel`).
      const eventTag: "auth-revoked" | "disconnected" | "rate-limited"
        | "other" | "invalid-datasource" =
        norm.tag === "cancelled" || norm.tag === "conflict"
          || norm.tag === "exhausted-retries"
          ? "other"
          : norm.tag;
      deps.fsSyncBus.emit("upload-failed", {
        uploadJobId,
        datasourceId: params.datasourceId,
        targetPath: params.targetPath,
        tag: eventTag,
        message: norm.message,
      });
      return { ok: false, error: norm };
    }

    // 10. Success — emit `file-created` and clear registry.
    deps.registry.delete(uploadJobId);
    deps.fsSyncBus.emit("file-created", {
      uploadJobId,
      datasourceId: params.datasourceId,
      targetPath: params.targetPath,
      handle: entry.handle,
    });
    return { ok: true, result: { uploadJobId } };
  };
}
