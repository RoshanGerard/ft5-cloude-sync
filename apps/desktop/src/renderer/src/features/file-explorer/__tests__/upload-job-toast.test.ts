// Task 9.1 — failing tests for the per-job Sonner upload toaster
// (`createUploadJobToaster`). Implementation lands in 9.2.
//
// Scenarios:
//   (a) onJobDispatched subscribes to progressApi.onUploadProgress(jobId)
//       and opens a `loading` toast referencing the basename.
//   (b) A `status: "uploading"` progress event with bytesUploaded=50 /
//       bytesTotal=100 updates the SAME toast id with a 50% message.
//   (c) Terminal `status: "completed"` calls toast.success with
//       duration=4000 and unsubscribes from the progress feed.
//   (d) Terminal `status: "failed"` with `error: "rate-limited"` calls
//       toast.error with a Retry action and `duration: Infinity` (no
//       auto-dismiss).
//   (e) Invoking the Retry action calls the `retry()` callback, then
//       unsubscribes the OLD progress feed and dismisses the OLD toast
//       id so the new dispatch can install its own toast.
//   (f) onBatchError calls toast.error with no jobId tracking.
//   (g) Two concurrent onJobDispatched calls produce two independent
//       toasts; an event for jobId A does not affect jobId B's toast.
//
// All collaborators (ToastApi, UploadProgressApi) are injected so the
// helper is exercised as a plain function — no Sonner, no window.api.

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { DatasourcesUploadProgressEvent } from "@ft5/ipc-contracts";

import {
  createUploadJobToaster,
  type ToastApi,
  type UploadProgressApi,
} from "../upload-job-toast.js";

// --- Mock factories --------------------------------------------------

interface MockToast extends ToastApi {
  loading: Mock;
  success: Mock;
  error: Mock;
  dismiss: Mock;
}

function makeToast(): MockToast {
  // Default: each call returns a unique id so multi-toast tests can
  // distinguish them. Tests that need a deterministic id override the
  // return value via mockReturnValueOnce.
  let next = 1;
  const loading = vi.fn(
    (_msg: string, opts?: { id?: string | number }) =>
      opts?.id ?? `toast-${next++}`,
  );
  const success = vi.fn(
    (_msg: string, opts?: { id?: string | number }) => opts?.id ?? `toast-${next++}`,
  );
  const error = vi.fn(
    (_msg: string, opts?: { id?: string | number }) => opts?.id ?? `toast-${next++}`,
  );
  const dismiss = vi.fn();
  return { loading, success, error, dismiss };
}

interface MockProgressApi extends UploadProgressApi {
  onUploadProgress: Mock;
  // Test helpers: dispatch an event into the registered listener for a
  // given jobId, and assert on the unsubscribe lifecycle.
  emit: (jobId: string, event: DatasourcesUploadProgressEvent) => void;
  unsubscribesFor: (jobId: string) => Mock | undefined;
}

function makeProgressApi(): MockProgressApi {
  const listeners = new Map<
    string,
    {
      cb: (event: DatasourcesUploadProgressEvent) => void;
      unsubscribe: Mock;
    }
  >();
  const onUploadProgress: Mock = vi.fn(
    (
      jobId: string,
      cb: (event: DatasourcesUploadProgressEvent) => void,
    ): (() => void) => {
      const unsubscribe = vi.fn();
      listeners.set(jobId, { cb, unsubscribe });
      return unsubscribe;
    },
  );
  return {
    onUploadProgress,
    emit(jobId, event) {
      const entry = listeners.get(jobId);
      if (!entry) {
        throw new Error(`no listener registered for jobId=${jobId}`);
      }
      entry.cb(event);
    },
    unsubscribesFor(jobId) {
      return listeners.get(jobId)?.unsubscribe;
    },
  };
}

function progressEvent(
  jobId: string,
  patch: Partial<DatasourcesUploadProgressEvent>,
): DatasourcesUploadProgressEvent {
  return {
    transactionId: jobId,
    bytesUploaded: 0,
    bytesTotal: 100,
    status: "uploading",
    ...patch,
  };
}

// --- Tests -----------------------------------------------------------

describe("createUploadJobToaster", () => {
  let toast: MockToast;
  let progressApi: MockProgressApi;

  beforeEach(() => {
    toast = makeToast();
    progressApi = makeProgressApi();
  });

  it("(a) onJobDispatched subscribes to the jobId feed and opens a loading toast referencing the basename", () => {
    const toaster = createUploadJobToaster({ toast, progressApi });

    toaster.onJobDispatched({
      jobId: "job-A",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });

    expect(progressApi.onUploadProgress).toHaveBeenCalledTimes(1);
    expect(progressApi.onUploadProgress.mock.calls[0]?.[0]).toBe("job-A");
    expect(toast.loading).toHaveBeenCalledTimes(1);
    const [message, opts] = toast.loading.mock.calls[0] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(message).toContain("report.pdf");
    expect(opts?.id).toBeDefined();
  });

  it("(b) progress event with status='uploading' 50/100 updates the SAME toast id with a 50% message", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const toaster = createUploadJobToaster({ toast, progressApi });

    toaster.onJobDispatched({
      jobId: "job-A",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });

    progressApi.emit(
      "job-A",
      progressEvent("job-A", {
        bytesUploaded: 50,
        bytesTotal: 100,
        status: "uploading",
      }),
    );

    expect(toast.loading).toHaveBeenCalledTimes(2);
    const secondCall = toast.loading.mock.calls[1] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(secondCall[1]?.id).toBe("toast-A");
    expect(secondCall[0]).toMatch(/50\s*%/);
  });

  it("(c) terminal status='completed' fires toast.success with duration=4000 and unsubscribes from the progress feed", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const toaster = createUploadJobToaster({ toast, progressApi });

    toaster.onJobDispatched({
      jobId: "job-A",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });

    progressApi.emit(
      "job-A",
      progressEvent("job-A", {
        bytesUploaded: 100,
        bytesTotal: 100,
        status: "completed",
      }),
    );

    expect(toast.success).toHaveBeenCalledTimes(1);
    const successCall = toast.success.mock.calls[0] as [
      string,
      { id?: string | number; duration?: number } | undefined,
    ];
    expect(successCall[1]?.id).toBe("toast-A");
    expect(successCall[1]?.duration).toBe(4000);

    const unsubscribe = progressApi.unsubscribesFor("job-A");
    expect(unsubscribe).toBeDefined();
    expect(unsubscribe!).toHaveBeenCalledTimes(1);
  });

  it("(d) terminal status='failed' fires toast.error with a Retry action and duration=Infinity (no auto-dismiss)", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const toaster = createUploadJobToaster({ toast, progressApi });

    toaster.onJobDispatched({
      jobId: "job-A",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });

    progressApi.emit(
      "job-A",
      progressEvent("job-A", {
        bytesUploaded: 0,
        bytesTotal: 100,
        status: "failed",
        error: "rate-limited",
      }),
    );

    expect(toast.error).toHaveBeenCalledTimes(1);
    const errorCall = toast.error.mock.calls[0] as [
      string,
      {
        id?: string | number;
        duration?: number;
        action?: { label: string; onClick: () => void };
      } | undefined,
    ];
    expect(errorCall[1]?.id).toBe("toast-A");
    expect(errorCall[1]?.duration).toBe(Number.POSITIVE_INFINITY);
    expect(errorCall[1]?.action).toBeDefined();
    expect(errorCall[1]?.action?.label).toMatch(/retry/i);
    expect(typeof errorCall[1]?.action?.onClick).toBe("function");
  });

  it("(e) clicking the Retry action calls retry(), unsubscribes the OLD feed, and dismisses the OLD toast id", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const toaster = createUploadJobToaster({ toast, progressApi });

    const retry = vi.fn(async () => {});
    toaster.onJobDispatched({
      jobId: "job-A",
      basename: "report.pdf",
      retry,
    });

    progressApi.emit(
      "job-A",
      progressEvent("job-A", {
        bytesUploaded: 0,
        bytesTotal: 100,
        status: "failed",
        error: "rate-limited",
      }),
    );

    const errorCall = toast.error.mock.calls[0] as [
      string,
      {
        action?: { label: string; onClick: () => void };
      } | undefined,
    ];
    const onClick = errorCall[1]?.action?.onClick;
    expect(onClick).toBeDefined();
    onClick!();

    expect(retry).toHaveBeenCalledTimes(1);

    // Old subscription unsubscribed so the next onJobDispatched can
    // bind a fresh feed without ghost listeners on the dead jobId.
    const unsubscribeA = progressApi.unsubscribesFor("job-A");
    expect(unsubscribeA).toBeDefined();
    expect(unsubscribeA!).toHaveBeenCalled();

    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");
  });

  it("(f) onBatchError calls toast.error with no jobId tracking", () => {
    const toaster = createUploadJobToaster({ toast, progressApi });

    toaster.onBatchError("Provider rate limit reached — try again shortly");

    expect(toast.error).toHaveBeenCalledTimes(1);
    const [message] = toast.error.mock.calls[0] as [string, unknown];
    expect(message).toMatch(/rate limit/i);
    // No subscription opened — onBatchError is for batch-level errors
    // that never produced a jobId.
    expect(progressApi.onUploadProgress).not.toHaveBeenCalled();
  });

  it("(g) two concurrent onJobDispatched calls produce TWO independent toasts; events for jobId A do not affect jobId B", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    toast.loading.mockReturnValueOnce("toast-B");
    const toaster = createUploadJobToaster({ toast, progressApi });

    toaster.onJobDispatched({
      jobId: "job-A",
      basename: "alpha.pdf",
      retry: vi.fn(async () => {}),
    });
    toaster.onJobDispatched({
      jobId: "job-B",
      basename: "beta.png",
      retry: vi.fn(async () => {}),
    });

    expect(progressApi.onUploadProgress).toHaveBeenCalledTimes(2);
    expect(toast.loading).toHaveBeenCalledTimes(2);

    // Emit a progress event ONLY for job-A and confirm the update
    // targets toast-A's id, not toast-B's.
    progressApi.emit(
      "job-A",
      progressEvent("job-A", {
        bytesUploaded: 25,
        bytesTotal: 100,
        status: "uploading",
      }),
    );

    // Of the loading calls after the initial two, the next is the
    // progress update for job-A only.
    expect(toast.loading).toHaveBeenCalledTimes(3);
    const updateCall = toast.loading.mock.calls[2] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(updateCall[1]?.id).toBe("toast-A");
    expect(updateCall[1]?.id).not.toBe("toast-B");

    // Complete job-B; success should target toast-B and unsubscribe
    // ONLY job-B's listener (job-A still active).
    progressApi.emit(
      "job-B",
      progressEvent("job-B", {
        bytesUploaded: 100,
        bytesTotal: 100,
        status: "completed",
      }),
    );
    const successCall = toast.success.mock.calls[0] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(successCall[1]?.id).toBe("toast-B");

    const unsubA = progressApi.unsubscribesFor("job-A");
    const unsubB = progressApi.unsubscribesFor("job-B");
    expect(unsubA!).not.toHaveBeenCalled();
    expect(unsubB!).toHaveBeenCalledTimes(1);
  });

  it("(h) retry → orchestrator re-dispatch → onJobDispatched(new jobId) opens a NEW toast bound to a fresh progress subscription", () => {
    // Task 9.3 round-trip: this proves that after the Retry action fires,
    // a fresh `onJobDispatched` for a new jobId opens a brand-new toast
    // and a brand-new progress subscription — no leakage from the
    // dismissed toast or the unsubscribed feed of the original jobId.
    toast.loading.mockReturnValueOnce("toast-A");
    const toaster = createUploadJobToaster({ toast, progressApi });

    // First dispatch: simulate the orchestrator's initial response.
    // `retry` is what `dispatchOne(plan)` would be — the test stubs it
    // out and asserts later that the toaster invokes it once.
    const retry = vi.fn(async () => {});
    toaster.onJobDispatched({
      jobId: "job-A",
      basename: "report.pdf",
      retry,
    });

    // Drive the failure path so the error toast is created with the
    // Retry action attached.
    progressApi.emit(
      "job-A",
      progressEvent("job-A", {
        bytesUploaded: 0,
        bytesTotal: 100,
        status: "failed",
        error: "rate-limited",
      }),
    );

    const errorCall = toast.error.mock.calls[0] as [
      string,
      {
        action?: { label: string; onClick: () => void };
      } | undefined,
    ];
    const onClick = errorCall[1]?.action?.onClick;
    expect(onClick).toBeDefined();

    // Click Retry. This should call `retry()`, unsubscribe job-A's feed,
    // and dismiss `toast-A` (covered by test (e)). We then simulate the
    // orchestrator's response by calling `onJobDispatched` for the new
    // jobId — exactly what the orchestrator's `dispatchOne(plan)` does
    // when its re-dispatched `files.upload` returns `{ ok: true,
    // value: { jobId } }`.
    onClick!();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");
    const unsubA = progressApi.unsubscribesFor("job-A");
    expect(unsubA!).toHaveBeenCalled();

    // Reset the retry handler so the new dispatch carries a fresh
    // closure (mirrors the orchestrator: each `dispatchOne` invocation
    // captures its own `plan` and creates a new `retry`).
    const retry2 = vi.fn(async () => {});
    toast.loading.mockReturnValueOnce("toast-B");
    toaster.onJobDispatched({
      jobId: "job-A2",
      basename: "report.pdf",
      retry: retry2,
    });

    // A NEW progress subscription was opened for the new jobId.
    expect(progressApi.onUploadProgress).toHaveBeenCalledTimes(2);
    const secondSubCall = progressApi.onUploadProgress.mock.calls[1] as [
      string,
      unknown,
    ];
    expect(secondSubCall[0]).toBe("job-A2");

    // A NEW loading toast was opened. Per test (a), the helper passes
    // an explicit `{ id }` to the initial `toast.loading` call (so
    // Sonner uses it as the toast key); the mock's
    // `mockReturnValueOnce("toast-B")` then overrides the return so
    // the helper captures `"toast-B"` as the canonical id for
    // subsequent updates. The load-bearing assertion is that the
    // captured id is DIFFERENT from the dismissed `"toast-A"` — we
    // verify that by emitting a progress event for `job-A2` and
    // asserting the update targets `"toast-B"`, not `"toast-A"`.

    // Confirm the new subscription routes updates to the new toast id.
    progressApi.emit(
      "job-A2",
      progressEvent("job-A2", {
        bytesUploaded: 25,
        bytesTotal: 100,
        status: "uploading",
      }),
    );
    const updateCall = toast.loading.mock.calls[
      toast.loading.mock.calls.length - 1
    ] as [string, { id?: string | number } | undefined];
    expect(updateCall[1]?.id).toBe("toast-B");
    expect(updateCall[1]?.id).not.toBe("toast-A");
  });

  it("(i) onJobCompleted is called with the jobId on terminal status='completed' and NOT for uploading or failed events", () => {
    // Bug 2 fix: the file-explorer wires `onJobCompleted` to
    // `store.retryLoad()` so the entries list refreshes once the
    // provider has acknowledged the new file. The callback must fire
    // ONLY on `completed` — uploading progress events and terminal
    // failures should not trigger a refetch (failed uploads leave the
    // file absent on the provider; refetching would surface nothing
    // new and would mask the real failure with churn).
    toast.loading.mockReturnValueOnce("toast-A");
    toast.loading.mockReturnValueOnce("toast-B");
    const onJobCompleted = vi.fn();
    const toaster = createUploadJobToaster({
      toast,
      progressApi,
      onJobCompleted,
    });

    // Dispatch job-A and emit an `uploading` event — must NOT call
    // onJobCompleted.
    toaster.onJobDispatched({
      jobId: "job-A",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });
    progressApi.emit(
      "job-A",
      progressEvent("job-A", {
        bytesUploaded: 50,
        bytesTotal: 100,
        status: "uploading",
      }),
    );
    expect(onJobCompleted).not.toHaveBeenCalled();

    // Drive job-A to terminal `completed` — onJobCompleted fires once
    // with the jobId.
    progressApi.emit(
      "job-A",
      progressEvent("job-A", {
        bytesUploaded: 100,
        bytesTotal: 100,
        status: "completed",
      }),
    );
    expect(onJobCompleted).toHaveBeenCalledTimes(1);
    expect(onJobCompleted).toHaveBeenCalledWith("job-A");

    // Dispatch job-B and drive it to terminal `failed` — must NOT call
    // onJobCompleted again (still 1 invocation total).
    toaster.onJobDispatched({
      jobId: "job-B",
      basename: "beta.png",
      retry: vi.fn(async () => {}),
    });
    progressApi.emit(
      "job-B",
      progressEvent("job-B", {
        bytesUploaded: 0,
        bytesTotal: 100,
        status: "failed",
        error: "rate-limited",
      }),
    );
    expect(onJobCompleted).toHaveBeenCalledTimes(1);
  });
});
