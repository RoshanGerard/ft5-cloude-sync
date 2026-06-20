// migrate-upload-orchestration-out-of-engine §14.5 — tests for the per-job
// Sonner upload toaster post-migration.
//
// The upload toaster now subscribes to a unified `sync:event-stream`
// instead of the legacy `datasources:upload:progress` channel. Each
// dispatched job opens ONE toast bound to its `uploadJobId`; the
// event-stream listener filters to the four upload kinds — `uploading`
// /`file-created`/`upload-failed`/`upload-cancelled` — and routes by
// `payload.uploadJobId`.
//
// The hydrate path (§15) is exposed as `hydrateActiveUploads(jobs)` —
// for each in-flight upload returned by `uploads:list-active`, mount a
// loading toast at the seeded percentage. Live events for those ids
// then update the existing toast in place rather than spawning a
// duplicate.
//
// Cancel action: Sonner's `toast.loading(...)` accepts an `action` opt;
// the toaster wires it to `syncApi.cancelUpload({ uploadJobId })`. Per
// the design this is fire-and-forget — the user-visible signal is the
// subsequent `upload-cancelled` event arriving on the bus, which the
// toaster's `upload-cancelled` handler dismisses with `toast.dismiss`.
//
// Scenarios covered:
//   (a) onJobDispatched mounts a loading toast referencing the basename;
//       no event subscription is created per-call (one global subscription
//       lives at the toaster level). The toast is keyed on `uploadJobId`.
//   (b) An `uploading` event with bytes/total updates the SAME toast id
//       with a percent-based message.
//   (c) `file-created` flips to toast.success (duration=4000) — bug 2's
//       `onJobCompleted` callback fires.
//   (d) `upload-failed` flips to red toast.error with Retry action and
//       duration=Infinity.
//   (e) Clicking Retry calls retry(), dismisses the OLD toast id, and
//       a fresh dispatch (`onJobDispatched(newJobId)`) opens a new
//       toast bound to the new uploadJobId.
//   (f) onBatchError calls toast.error (no jobId tracking).
//   (g) Two concurrent dispatches produce two independent toasts; an
//       event for one uploadJobId does not affect the other.
//   (h) A `tag: "conflict"` upload dispatch error surfaces a one-off
//       error toast pointing at the existing job (handled by the
//       orchestrator, not the toaster — kept here as a §14.3 anchor).
//   (i) hydrateActiveUploads pre-seeds toasts for in-flight jobs; the
//       next live `uploading` event for that id updates the existing
//       toast instead of spawning a duplicate.
//   (j) `upload-cancelled` event silently dismisses the toast (no
//       success/failure state).
//
// All collaborators (ToastApi, UploadEventApi, SyncActionsApi) are
// injected so the helper is exercised as a plain function — no Sonner,
// no window.api.

import { FilesErrorTag } from "@ft5/ipc-contracts";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  createUploadJobToaster,
  type SyncActionsApi,
  type ToastApi,
  type UploadEvent,
  type UploadEventApi,
  type UploadJobSummary,
} from "../upload-job-toast.js";

// --- Mock factories --------------------------------------------------

interface MockToast extends ToastApi {
  loading: Mock;
  success: Mock;
  error: Mock;
  dismiss: Mock;
}

function makeToast(): MockToast {
  let next = 1;
  const loading = vi.fn(
    (_msg: string, opts?: { id?: string | number }) =>
      opts?.id ?? `toast-${next++}`,
  );
  const success = vi.fn(
    (_msg: string, opts?: { id?: string | number }) =>
      opts?.id ?? `toast-${next++}`,
  );
  const error = vi.fn(
    (_msg: string, opts?: { id?: string | number }) =>
      opts?.id ?? `toast-${next++}`,
  );
  const dismiss = vi.fn();
  return { loading, success, error, dismiss };
}

interface MockEventApi extends UploadEventApi {
  onUploadEvent: Mock;
  emit: (event: UploadEvent) => void;
}

function makeEventApi(): MockEventApi {
  let listener: ((event: UploadEvent) => void) | null = null;
  const onUploadEvent: Mock = vi.fn((cb: (event: UploadEvent) => void) => {
    listener = cb;
    return () => {
      listener = null;
    };
  });
  return {
    onUploadEvent,
    emit(event) {
      if (!listener) throw new Error("no upload-event listener registered");
      listener(event);
    },
  };
}

interface MockSyncApi extends SyncActionsApi {
  cancelUpload: Mock;
}

function makeSyncApi(): MockSyncApi {
  return {
    cancelUpload: vi.fn(async () => ({ cancelled: true })),
  };
}

// --- Tests -----------------------------------------------------------

describe("createUploadJobToaster — sync:event-stream subscription", () => {
  let toast: MockToast;
  let eventApi: MockEventApi;
  let syncApi: MockSyncApi;

  beforeEach(() => {
    toast = makeToast();
    eventApi = makeEventApi();
    syncApi = makeSyncApi();
  });

  it("(a) onJobDispatched mounts a loading toast referencing the basename keyed on uploadJobId; one global subscription covers all dispatches", () => {
    const toaster = createUploadJobToaster({ toast, eventApi, syncApi });

    toaster.onJobDispatched({
      jobId: "u-A",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });
    toaster.onJobDispatched({
      jobId: "u-B",
      basename: "beta.png",
      retry: vi.fn(async () => {}),
    });

    // ONE event subscription, not one per dispatch.
    expect(eventApi.onUploadEvent).toHaveBeenCalledTimes(1);
    expect(toast.loading).toHaveBeenCalledTimes(2);
    const firstCall = toast.loading.mock.calls[0] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(firstCall[0]).toContain("report.pdf");
    expect(firstCall[1]?.id).toBeDefined();

    toaster.dispose();
  });

  it("(b) an `uploading` event for the dispatched uploadJobId updates the SAME toast id with a percent-based message", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const toaster = createUploadJobToaster({ toast, eventApi, syncApi });

    toaster.onJobDispatched({
      jobId: "u-A",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });

    eventApi.emit({
      kind: "uploading",
      payload: {
        uploadJobId: "u-A",
        datasourceId: "ds-1",
        sourcePath: "C:/local/report.pdf",
        targetPath: "/projects/2026/report.pdf",
        bytesUploaded: 50,
        bytesTotal: 100,
      },
    });

    expect(toast.loading).toHaveBeenCalledTimes(2);
    const update = toast.loading.mock.calls[1] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(update[1]?.id).toBe("toast-A");
    expect(update[0]).toMatch(/50\s*%/);

    toaster.dispose();
  });

  it("(c) terminal `file-created` flips to toast.success (duration=4000) and onJobCompleted fires with the uploadJobId", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const onJobCompleted = vi.fn();
    const toaster = createUploadJobToaster({
      toast,
      eventApi,
      syncApi,
      onJobCompleted,
    });

    toaster.onJobDispatched({
      jobId: "u-A",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });

    eventApi.emit({
      kind: "file-created",
      payload: {
        uploadJobId: "u-A",
        datasourceId: "ds-1",
        targetPath: "/projects/2026/report.pdf",
        handle: "drive-file-123",
      },
    });

    expect(toast.success).toHaveBeenCalledTimes(1);
    const successCall = toast.success.mock.calls[0] as [
      string,
      { id?: string | number; duration?: number } | undefined,
    ];
    expect(successCall[1]?.id).toBe("toast-A");
    expect(successCall[1]?.duration).toBe(4000);
    expect(onJobCompleted).toHaveBeenCalledWith("u-A");

    toaster.dispose();
  });

  it("(d) terminal `upload-failed` flips to red toast.error with Retry action and duration=Infinity", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const toaster = createUploadJobToaster({ toast, eventApi, syncApi });

    toaster.onJobDispatched({
      jobId: "u-A",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });

    eventApi.emit({
      kind: "upload-failed",
      payload: {
        uploadJobId: "u-A",
        datasourceId: "ds-1",
        targetPath: "/projects/2026/report.pdf",
        tag: FilesErrorTag.RateLimited,
        message: "Slow down",
      },
    });

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
    expect(errorCall[1]?.action?.label).toMatch(/retry/i);
    expect(typeof errorCall[1]?.action?.onClick).toBe("function");

    toaster.dispose();
  });

  it("(e) clicking Retry invokes retry() and dismisses the OLD toast id; a fresh dispatch opens a new toast for the new uploadJobId", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const toaster = createUploadJobToaster({ toast, eventApi, syncApi });

    const retry = vi.fn(async () => {});
    toaster.onJobDispatched({
      jobId: "u-A",
      basename: "report.pdf",
      retry,
    });

    eventApi.emit({
      kind: "upload-failed",
      payload: {
        uploadJobId: "u-A",
        datasourceId: "ds-1",
        targetPath: "/projects/2026/report.pdf",
        tag: FilesErrorTag.RateLimited,
        message: "Slow down",
      },
    });

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
    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");

    // Re-dispatch from the orchestrator: a fresh `onJobDispatched` call
    // for the new uploadJobId opens a NEW toast on a fresh id.
    toast.loading.mockReturnValueOnce("toast-B");
    toaster.onJobDispatched({
      jobId: "u-A2",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });

    // Confirm subsequent events route to the new toast id.
    eventApi.emit({
      kind: "uploading",
      payload: {
        uploadJobId: "u-A2",
        datasourceId: "ds-1",
        sourcePath: "C:/local/report.pdf",
        targetPath: "/projects/2026/report.pdf",
        bytesUploaded: 25,
        bytesTotal: 100,
      },
    });
    const lastUpdate = toast.loading.mock.calls[
      toast.loading.mock.calls.length - 1
    ] as [string, { id?: string | number } | undefined];
    expect(lastUpdate[1]?.id).toBe("toast-B");
    expect(lastUpdate[1]?.id).not.toBe("toast-A");

    toaster.dispose();
  });

  it("(f) onBatchError fires toast.error without opening a subscription", () => {
    const toaster = createUploadJobToaster({ toast, eventApi, syncApi });

    toaster.onBatchError("Provider rate limit reached — try again shortly");

    expect(toast.error).toHaveBeenCalledTimes(1);
    const [message] = toast.error.mock.calls[0] as [string, unknown];
    expect(message).toMatch(/rate limit/i);
    // ONE global subscription regardless of dispatch — onBatchError
    // doesn't add another.
    expect(eventApi.onUploadEvent).toHaveBeenCalledTimes(1);

    toaster.dispose();
  });

  it("(g) two concurrent dispatches produce TWO independent toasts; an event for one does not affect the other", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    toast.loading.mockReturnValueOnce("toast-B");
    const toaster = createUploadJobToaster({ toast, eventApi, syncApi });

    toaster.onJobDispatched({
      jobId: "u-A",
      basename: "alpha.pdf",
      retry: vi.fn(async () => {}),
    });
    toaster.onJobDispatched({
      jobId: "u-B",
      basename: "beta.png",
      retry: vi.fn(async () => {}),
    });

    expect(toast.loading).toHaveBeenCalledTimes(2);

    // Progress for u-A only.
    eventApi.emit({
      kind: "uploading",
      payload: {
        uploadJobId: "u-A",
        datasourceId: "ds-1",
        sourcePath: "C:/local/alpha.pdf",
        targetPath: "/alpha.pdf",
        bytesUploaded: 25,
        bytesTotal: 100,
      },
    });
    expect(toast.loading).toHaveBeenCalledTimes(3);
    const updateCall = toast.loading.mock.calls[2] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(updateCall[1]?.id).toBe("toast-A");
    expect(updateCall[1]?.id).not.toBe("toast-B");

    // Complete u-B; success targets toast-B.
    eventApi.emit({
      kind: "file-created",
      payload: {
        uploadJobId: "u-B",
        datasourceId: "ds-1",
        targetPath: "/beta.png",
        handle: "h-2",
      },
    });
    const successCall = toast.success.mock.calls[0] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(successCall[1]?.id).toBe("toast-B");

    toaster.dispose();
  });

  it("(i) hydrateActiveUploads pre-seeds toasts; subsequent live `uploading` events update the seeded toast in place", () => {
    toast.loading.mockReturnValueOnce("toast-hydrated-A");
    const toaster = createUploadJobToaster({ toast, eventApi, syncApi });

    const hydrated: readonly UploadJobSummary[] = [
      {
        uploadJobId: "u-A",
        datasourceId: "ds-1",
        sourcePath: "C:/local/report.pdf",
        targetPath: "/projects/2026/report.pdf",
        bytesUploaded: 30_000,
        contentLength: 100_000,
        startedAt: 1_700_000_000_000,
      },
    ];
    toaster.hydrateActiveUploads(hydrated);

    expect(toast.loading).toHaveBeenCalledTimes(1);
    const seedCall = toast.loading.mock.calls[0] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(seedCall[0]).toContain("report.pdf");

    // Live event for the seeded id targets the SAME toast id, no new
    // toast spawn.
    eventApi.emit({
      kind: "uploading",
      payload: {
        uploadJobId: "u-A",
        datasourceId: "ds-1",
        sourcePath: "C:/local/report.pdf",
        targetPath: "/projects/2026/report.pdf",
        bytesUploaded: 60_000,
        bytesTotal: 100_000,
      },
    });
    expect(toast.loading).toHaveBeenCalledTimes(2);
    const updateCall = toast.loading.mock.calls[1] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(updateCall[1]?.id).toBe("toast-hydrated-A");

    toaster.dispose();
  });

  it("(j) `upload-cancelled` silently dismisses the toast (no success / no failure render)", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const toaster = createUploadJobToaster({ toast, eventApi, syncApi });

    toaster.onJobDispatched({
      jobId: "u-A",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });

    eventApi.emit({
      kind: "upload-cancelled",
      payload: {
        uploadJobId: "u-A",
        datasourceId: "ds-1",
        sourcePath: "C:/local/report.pdf",
        targetPath: "/projects/2026/report.pdf",
        bytesUploaded: 10,
        bytesTotal: 100,
        reason: "user",
      },
    });

    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    toaster.dispose();
  });

  it("Cancel action on a loading toast invokes syncApi.cancelUpload({ uploadJobId }) without awaiting", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const toaster = createUploadJobToaster({ toast, eventApi, syncApi });

    toaster.onJobDispatched({
      jobId: "u-A",
      basename: "report.pdf",
      retry: vi.fn(async () => {}),
    });

    const initialCall = toast.loading.mock.calls[0] as [
      string,
      {
        id?: string | number;
        action?: { label: string; onClick: () => void };
      } | undefined,
    ];
    const cancelAction = initialCall[1]?.action;
    expect(cancelAction).toBeDefined();
    expect(cancelAction?.label).toMatch(/cancel/i);

    cancelAction!.onClick();
    expect(syncApi.cancelUpload).toHaveBeenCalledWith({ uploadJobId: "u-A" });

    toaster.dispose();
  });
});
