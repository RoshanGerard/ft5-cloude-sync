// Upload orchestrator for the file-explorer drag/drop + dialog flows.
//
// This hook is stateless by design — it returns an imperative `start()`
// that the caller invokes once per batch. No React state is tracked
// here; per-job progress UI lives inside Sonner toasts (Task 9) and the
// conflict dialog owns its own dialog state (Task 7). Keeping this
// layer stateless means we can unit-test it as a plain function.
//
// Flow per `start()`:
//   1. Compute target paths and issue N `files.stat` preflights in
//      parallel.
//   2. If any stat surfaces `auth-revoked` / `disconnected` /
//      `rate-limited`, or the IPC bridge itself throws, ABORT — no
//      file is dispatched.
//   3. Otherwise classify each file: `ok: true` → conflict; `ok: false`
//      → no conflict. The renderer envelope collapses engine-level
//      `not-found` into `tag: "other"` (see
//      apps/desktop/src/main/ipc/files/error-envelope.ts), so this
//      layer cannot distinguish "target absent" from "generic provider
//      error" on preflight; both are treated as no-conflict and the
//      engine re-validates at enqueue time.
//   4. Hand the conflict list to the injected resolver. If it aborts,
//      return. Otherwise map `overwrite`/`duplicate`/`skip` to a
//      `ConflictPolicy`, dropping `skip` files from the dispatch list.
//   5. Dispatch `files.upload` for every surviving file in parallel.
//      One successful response fires `toaster.onJobDispatched`; one
//      failed response fires `toaster.onBatchError` with the per-file
//      message (per-file failures are INDEPENDENT — one failing does
//      not prevent the others from dispatching).

import type {
  ConflictPolicy,
  FilesStatRequest,
  FilesStatResponse,
  FilesUploadRequest,
  FilesUploadResponse,
} from "@ft5/ipc-contracts";

import type {
  ConflictChoice,
  ConflictInfo,
  UploadFileItem,
} from "./resolve-conflicts.js";

export type { ConflictChoice, ConflictInfo, UploadFileItem };

export interface ConflictResolver {
  /**
   * Walk the conflicts serially (Task 7's dialog implements this).
   * Returns one `ConflictChoice` per conflict in the same order, or
   * `{ aborted: true }` to cancel the whole batch.
   */
  resolve(
    conflicts: readonly ConflictInfo[],
  ): Promise<
    | { aborted: false; choices: readonly ConflictChoice[] }
    | { aborted: true }
  >;
}

export interface UploadJobDispatch {
  readonly jobId: string;
  readonly basename: string;
  /**
   * Re-dispatches the same `files.upload` call for this single file.
   * Wiring into Sonner (replace old toast with new toast bound to the
   * new jobId) happens in Task 9's helper.
   */
  readonly retry: () => Promise<void>;
}

export interface UploadToaster {
  onJobDispatched(args: UploadJobDispatch): void;
  onBatchError(message: string): void;
}

export interface UploadOrchestratorApi {
  stat: (req: FilesStatRequest) => Promise<FilesStatResponse>;
  upload: (req: FilesUploadRequest) => Promise<FilesUploadResponse>;
}

export interface UploadOrchestratorArgs {
  readonly datasourceId: string;
  readonly targetDir: string;
  readonly files: readonly UploadFileItem[];
  readonly conflictResolver: ConflictResolver;
  readonly toaster: UploadToaster;
  /**
   * Injected so tests never need `window.api`. Omit in production and
   * the orchestrator falls back to the preload bridge.
   */
  readonly api?: UploadOrchestratorApi;
}

export interface UploadOrchestratorResult {
  start(): Promise<void>;
}

function joinDatasourcePath(dir: string, basename: string): string {
  // Datasource paths are POSIX-style with exactly one slash between
  // segments. Normalize the trailing slash on `dir` and the leading
  // slash on `basename` defensively — callers shouldn't pass weird
  // shapes but we can't assume the drop payload is well-formed.
  const trimmedDir = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const trimmedName = basename.startsWith("/") ? basename.slice(1) : basename;
  return `${trimmedDir}/${trimmedName}`;
}

function choiceToPolicy(choice: ConflictChoice): ConflictPolicy {
  switch (choice.kind) {
    case "overwrite":
      return "overwrite";
    case "duplicate":
      return "duplicate";
    case "skip":
      return "skip";
  }
}

function resolveApi(injected: UploadOrchestratorApi | undefined): UploadOrchestratorApi {
  if (injected) return injected;
  // Production fallback — pull from the preload bridge. Kept narrow
  // so tests that never touch `window.api` still satisfy the type.
  const api = (
    globalThis as unknown as {
      window?: { api?: { files?: UploadOrchestratorApi } };
    }
  ).window?.api?.files;
  if (!api) {
    throw new Error(
      "useUploadOrchestrator: no api provided and window.api.files is unavailable",
    );
  }
  return api;
}

interface PreflightAbort {
  readonly kind: "abort";
  readonly message: string;
}

interface PreflightClassified {
  readonly kind: "classified";
  readonly conflicts: readonly ConflictInfo[];
  // Index-aligned with `args.files` — `true` means the target exists
  // (conflict), `false` means free to dispatch.
  readonly conflictMask: readonly boolean[];
}

type PreflightOutcome = PreflightAbort | PreflightClassified;

function tagToAbortMessage(tag: string): string | null {
  switch (tag) {
    case "auth-revoked":
      return "Sign in again to upload files";
    case "disconnected":
      return "Datasource unreachable — try again when connected";
    case "rate-limited":
      return "Provider rate limit reached — try again shortly";
    default:
      return null;
  }
}

async function preflight(
  api: UploadOrchestratorApi,
  datasourceId: string,
  files: readonly UploadFileItem[],
  targetPaths: readonly string[],
): Promise<PreflightOutcome> {
  const settled = await Promise.allSettled(
    targetPaths.map((path) => api.stat({ datasourceId, path })),
  );

  // First pass: any rejected promise (IPC failure) or abort-tag error
  // poisons the whole batch. The first matching reason wins; the
  // message is either the exception text or the mapped tag message.
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      const err = outcome.reason;
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "abort", message };
    }
    const response = outcome.value;
    if (!response.ok) {
      const abortMessage = tagToAbortMessage(response.error.tag);
      if (abortMessage !== null) {
        return { kind: "abort", message: abortMessage };
      }
    }
  }

  const conflicts: ConflictInfo[] = [];
  const conflictMask: boolean[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const outcome = settled[i];
    const file = files[i];
    const targetPath = targetPaths[i];
    if (!outcome || !file || targetPath === undefined) continue;
    // `outcome.status === "rejected"` is already handled above as an
    // abort; we only reach here on "fulfilled" outcomes.
    if (outcome.status !== "fulfilled") continue;
    const response = outcome.value;
    if (response.ok) {
      conflicts.push({
        file,
        targetPath,
        existing: {
          sizeBytes: response.value.entry.size,
          modifiedAt: response.value.entry.modifiedAt,
        },
      });
      conflictMask.push(true);
    } else {
      // `ok: false` with a non-abort tag (`other`, plus any future
      // non-abort tags) → treat as no-conflict. The engine will
      // re-validate at enqueue time.
      conflictMask.push(false);
    }
  }

  return { kind: "classified", conflicts, conflictMask };
}

interface DispatchPlan {
  readonly file: UploadFileItem;
  readonly targetPath: string;
  readonly conflictPolicy: ConflictPolicy;
}

export function useUploadOrchestrator(
  args: UploadOrchestratorArgs,
): UploadOrchestratorResult {
  const api = resolveApi(args.api);

  // Per-file dispatch wrapped so both the initial batch and the
  // `retry` closure on each toast go through the same code path.
  async function dispatchOne(plan: DispatchPlan): Promise<void> {
    let response: FilesUploadResponse;
    try {
      response = await api.upload({
        datasourceId: args.datasourceId,
        sourcePath: plan.file.sourcePath,
        targetPath: plan.targetPath,
        conflictPolicy: plan.conflictPolicy,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      args.toaster.onBatchError(message);
      return;
    }
    if (response.ok) {
      args.toaster.onJobDispatched({
        jobId: response.value.jobId,
        basename: plan.file.basename,
        retry: () => dispatchOne(plan),
      });
    } else {
      args.toaster.onBatchError(response.error.message);
    }
  }

  async function start(): Promise<void> {
    if (args.files.length === 0) return;

    const targetPaths = args.files.map((f) =>
      joinDatasourcePath(args.targetDir, f.basename),
    );

    const outcome = await preflight(
      api,
      args.datasourceId,
      args.files,
      targetPaths,
    );
    if (outcome.kind === "abort") {
      args.toaster.onBatchError(outcome.message);
      return;
    }

    // If any conflicts, let the resolver (the dialog) walk them.
    const choicesByFileIndex: Map<number, ConflictChoice> = new Map();
    if (outcome.conflicts.length > 0) {
      const resolved = await args.conflictResolver.resolve(outcome.conflicts);
      if (resolved.aborted) return;

      // Correlate resolver choices (one per conflict, in order) back to
      // the original file-index space so dispatch can walk `args.files`
      // naturally.
      let conflictCursor = 0;
      for (let i = 0; i < args.files.length; i += 1) {
        if (outcome.conflictMask[i]) {
          const choice = resolved.choices[conflictCursor];
          if (choice !== undefined) {
            choicesByFileIndex.set(i, choice);
          }
          conflictCursor += 1;
        }
      }
    }

    const plans: DispatchPlan[] = [];
    for (let i = 0; i < args.files.length; i += 1) {
      const file = args.files[i];
      const targetPath = targetPaths[i];
      if (!file || targetPath === undefined) continue;

      if (outcome.conflictMask[i]) {
        const choice = choicesByFileIndex.get(i);
        if (!choice) continue;
        const policy = choiceToPolicy(choice);
        if (policy === "skip") continue;
        plans.push({ file, targetPath, conflictPolicy: policy });
      } else {
        // No conflict → design.md Decision 8: dispatch with
        // "overwrite" so the engine's idempotent-upload semantics
        // stay consistent with the conflict path.
        plans.push({ file, targetPath, conflictPolicy: "overwrite" });
      }
    }

    // Dispatches are independent — one failing does not prevent the
    // others. `dispatchOne` never rejects (it funnels all errors
    // through the toaster ports), so `Promise.all` is safe here.
    await Promise.all(plans.map((plan) => dispatchOne(plan)));
  }

  return { start };
}
