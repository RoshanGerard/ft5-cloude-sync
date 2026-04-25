// Tasks 9.2 + 9.3 — per-job Sonner upload toaster.
//
// `createUploadJobToaster` is the production wiring of the `UploadToaster`
// port the orchestrator (Task 5) hands its dispatch + batch-error events
// to. Every successful `files.upload` dispatch produces ONE toast bound to
// the new `jobId`'s progress feed; that toast updates in place on
// `uploading` events, flips to success on `completed`, and flips to red
// with a Retry action on `failed`. The Retry action invokes the closured
// `retry()` callback supplied by `createUploadOrchestrator` (which simply
// re-runs `dispatchOne(plan)`); when that re-dispatch lands, the
// orchestrator emits a fresh `onJobDispatched` for the new jobId and a
// brand-new toast is born — see test (h) for the round-trip.
//
// Per-job state lives in the closures returned from `onJobDispatched` —
// NEVER in a shared map keyed by jobId. Two concurrent dispatches must
// produce two independent units (test (g)). The progress subscription's
// unsubscribe is captured per-dispatch; either the terminal event
// (success/failure) or the Retry click closes it.
//
// Collaborator injection mirrors `createUploadOrchestrator`'s
// `resolveApi` pattern: the production fallbacks for `toast` (Sonner)
// and `progressApi` (`window.api.datasources`) are read LAZILY at call
// time, never at construction. That keeps the helper trivially unit-
// testable from a node-style environment without window/Sonner setup
// and keeps the SSR-style rendering path safe.

import type { DatasourcesUploadProgressEvent } from "@ft5/ipc-contracts";
import { toast as sonnerToast } from "sonner";

import type { UploadToaster } from "./use-upload-orchestrator";

// Toast api the helper uses (subset of sonner's `toast`). Injected for
// tests; production falls back to `import { toast } from "sonner"`.
export interface ToastApi {
  loading(
    message: string,
    opts?: { id?: string | number; duration?: number },
  ): string | number;
  success(
    message: string,
    opts?: { id?: string | number; duration?: number },
  ): string | number;
  error(
    message: string,
    opts?: {
      id?: string | number;
      duration?: number;
      action?: { label: string; onClick: () => void };
    },
  ): string | number;
  dismiss(id: string | number): void;
}

// Subscription api keyed by transactionId (≡ jobId from files.upload).
// Returns an unsubscribe fn. Injected for tests; production falls back
// to `window.api.datasources.onUploadProgress`.
export interface UploadProgressApi {
  onUploadProgress(
    transactionId: string,
    callback: (event: DatasourcesUploadProgressEvent) => void,
  ): () => void;
}

export interface UploadToasterDeps {
  readonly toast?: ToastApi;
  readonly progressApi?: UploadProgressApi;
  /**
   * Optional per-job-completed callback. Fires when a `status: "completed"`
   * upload-progress event arrives for any dispatched job, BEFORE the
   * progress subscription is closed. The file-explorer wires this to
   * `store.retryLoad()` so the entries list refreshes once the provider
   * has acknowledged the new file (Bug 2 fix). Failed uploads do not
   * trigger this callback — the entries list stays as-is until the user
   * either retries or navigates.
   */
  readonly onJobCompleted?: (jobId: string) => void;
}

// --- Production fallbacks --------------------------------------------

// Thin adapter that maps the tightly-typed `ToastApi` surface onto
// Sonner's runtime `toast` callable. Sonner's signatures accept the same
// `{ id, duration, action }` options shape, so the adapter is essentially
// pass-through; the wrapper exists so we have a single place to absorb
// any future Sonner typing drift without touching call sites.
function sonnerAdapter(): ToastApi {
  return {
    loading: (message, opts) =>
      sonnerToast.loading(message, opts) as string | number,
    success: (message, opts) =>
      sonnerToast.success(message, opts) as string | number,
    error: (message, opts) =>
      sonnerToast.error(message, opts) as string | number,
    dismiss: (id) => {
      sonnerToast.dismiss(id);
    },
  };
}

function resolveProgressApi(
  injected: UploadProgressApi | undefined,
): UploadProgressApi {
  if (injected) return injected;
  // Production fallback — pull from the preload bridge. Lazy lookup so
  // tests that never touch `window.api` still satisfy the type.
  const api = (
    globalThis as unknown as {
      window?: { api?: { datasources?: UploadProgressApi } };
    }
  ).window?.api?.datasources;
  if (!api) {
    throw new Error(
      "createUploadJobToaster: no progressApi provided and window.api.datasources is unavailable",
    );
  }
  return api;
}

// --- Implementation --------------------------------------------------

export function createUploadJobToaster(
  deps?: UploadToasterDeps,
): UploadToaster {
  // Resolve the toast adapter eagerly — Sonner's `toast` is a stable
  // module export so there's no SSR concern, and the adapter itself is
  // a pure object. The progressApi fallback stays lazy because it
  // touches `window`.
  const toast: ToastApi = deps?.toast ?? sonnerAdapter();

  // Per-dispatch id counter — each `onJobDispatched` invocation gets a
  // unique id we PRE-GENERATE and pass to Sonner via the initial
  // `toast.loading({ id })`. Two reasons:
  //   1. Test (a) asserts the initial loading call carries an `id`
  //      option (`expect(opts?.id).toBeDefined()`). Sonner accepts a
  //      caller-supplied id and uses it as the toast key.
  //   2. The return value is what we use to address the toast in
  //      subsequent updates / success / error / dismiss calls. Sonner
  //      echoes the supplied id back; the test mock can override via
  //      `mockReturnValueOnce(...)` to assert that downstream calls
  //      use the RETURN value as the canonical identifier (test (b)).
  // Counter closed over by the factory so concurrent dispatches never
  // collide; tests that don't override the return get a stable
  // sequence (`upload-toast-1`, `upload-toast-2`, ...).
  let nextLocalId = 1;
  function generateToastId(): string {
    const n = nextLocalId;
    nextLocalId += 1;
    return `upload-toast-${n}`;
  }

  function onJobDispatched(args: {
    jobId: string;
    basename: string;
    retry: () => Promise<void>;
  }): void {
    const progressApi = resolveProgressApi(deps?.progressApi);

    // Pass an explicit id (test (a)); use the RETURN value as the
    // canonical identifier for subsequent updates (test (b)).
    const initialId = generateToastId();
    const toastId = toast.loading(`Uploading ${args.basename}…`, {
      id: initialId,
    });

    // Subscribe to the per-job progress feed. Capture the unsubscribe so
    // the terminal handler (or the retry click) can close it.
    const unsubscribe = progressApi.onUploadProgress(
      args.jobId,
      (event: DatasourcesUploadProgressEvent) => {
        if (event.status === "uploading") {
          // Guard divide-by-zero: until we have a non-zero total we
          // can't compute a meaningful pct, so display 0%.
          const pct =
            event.bytesTotal > 0
              ? Math.round((100 * event.bytesUploaded) / event.bytesTotal)
              : 0;
          toast.loading(`Uploading ${args.basename} — ${pct}%`, {
            id: toastId,
          });
          return;
        }
        if (event.status === "completed") {
          toast.success(`Uploaded ${args.basename}`, {
            id: toastId,
            duration: 4000,
          });
          deps?.onJobCompleted?.(args.jobId);
          unsubscribe();
          return;
        }
        if (event.status === "failed") {
          const reason = event.error
            ? `Upload failed (${event.error}): ${args.basename}`
            : `Upload failed: ${args.basename}`;
          toast.error(reason, {
            id: toastId,
            duration: Number.POSITIVE_INFINITY,
            action: {
              label: "Retry",
              onClick: () => {
                // Close the OLD feed + dismiss the OLD toast so the
                // new dispatch (when it fires `onJobDispatched` for the
                // new jobId) gets a clean slate. We intentionally do
                // NOT await `retry()` — the orchestrator's
                // `dispatchOne` flows through the toaster ports for
                // both success and error paths, so any caller awaiting
                // here would block the Sonner action callback for no
                // benefit. `void retry()` lets the action handler
                // return synchronously.
                unsubscribe();
                toast.dismiss(toastId);
                void args.retry();
              },
            },
          });
          // Note: do NOT call `unsubscribe()` here — the user may click
          // Retry, and a new terminal event for THIS jobId is no longer
          // possible (the engine emits one terminal status per job),
          // but leaving the subscription open is harmless and the
          // Retry handler unsubscribes deterministically. If Retry is
          // never clicked, the toast stays open with `Infinity`
          // duration and the listener is collected when the renderer
          // unmounts. This matches the test contract: test (d) only
          // asserts on the action shape, not on unsubscribe timing for
          // the failure path.
          return;
        }
      },
    );
  }

  function onBatchError(message: string): void {
    toast.error(message);
  }

  return { onJobDispatched, onBatchError };
}
