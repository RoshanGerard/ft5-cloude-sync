/** @vitest-environment jsdom */
//
// add-engine-rename-download §24.1 + §24.3 — RED tests for the per-job
// Sonner download toaster (`createDownloadJobToaster`).
//
// Per design.md Decision 8 the toaster is decoupled from the
// orchestrator: it subscribes to the global download-event stream
// (`window.api.sync.onEvent` filtered to the four download lifecycle
// kinds) and spawns one Sonner toast per previously-unseen
// `downloadJobId`. Subsequent events for the same id update the toast
// in place.
//
// Test scenarios:
//   §24.1
//     (a) FIRST `downloading` event for a new downloadJobId opens a
//         loading toast with a progress percentage referencing the
//         basename.
//     (b) Subsequent `downloading` events for the same id update the
//         SAME toast id with the new percentage.
//     (c) Terminal `file-downloaded` event flips the toast to a
//         success variant rendered via `toast.custom()`. The custom
//         render carries [Show in folder] (text link) + [Open] (filled
//         primary CTA) wired to `files.openSavedPath` /
//         `files.showSavedInFolder`. Subscription auto-unsubscribes
//         (success path doesn't need to keep listening — terminal events
//         are one-shot per the contract).
//     (d) Terminal `download-failed` flips the toast to a red error
//         variant with `richColors: true` and a Retry action.
//     (e) Terminal `download-cancelled` silently dismisses the toast.
//     (f) Two concurrent downloads with distinct downloadJobIds produce
//         TWO independent toasts; an event for jobId A does not affect
//         jobId B's toast.
//
//   §24.3
//     (g) `hydrateActiveDownloads(jobs)` spawns one toast per DownloadJob
//         with the seeded `bytesDownloaded`/`contentLength` ratio as
//         initial progress; subsequent live events for any of those ids
//         update the existing toast (not create a duplicate).

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  createDownloadJobToaster,
  type DownloadEvent,
  type DownloadEventApi,
  type DownloadJobSummary,
  type ToastApi,
} from "../download-job-toast.js";

// --- Mock factories --------------------------------------------------

interface MockToast extends ToastApi {
  loading: Mock;
  success: Mock;
  error: Mock;
  dismiss: Mock;
  custom: Mock;
}

function makeToast(): MockToast {
  let next = 1;
  const loading: Mock = vi.fn(
    (_msg: string, opts?: { id?: string | number }) =>
      opts?.id ?? `toast-${next++}`,
  );
  const success: Mock = vi.fn(
    (_msg: string, opts?: { id?: string | number }) =>
      opts?.id ?? `toast-${next++}`,
  );
  const error: Mock = vi.fn(
    (_msg: string, opts?: { id?: string | number }) =>
      opts?.id ?? `toast-${next++}`,
  );
  const dismiss: Mock = vi.fn();
  // toast.custom takes a render function. We don't render in node — the
  // mock just records the call args so tests can assert on the render
  // function's output by invoking it.
  const custom: Mock = vi.fn(
    (_render: unknown, opts?: { id?: string | number }) =>
      opts?.id ?? `toast-${next++}`,
  );
  return { loading, success, error, dismiss, custom };
}

interface MockEventApi extends DownloadEventApi {
  onDownloadEvent: Mock;
  emit: (event: DownloadEvent) => void;
  unsubscribe: Mock;
}

function makeEventApi(): MockEventApi {
  let listener: ((event: DownloadEvent) => void) | null = null;
  const unsubscribe: Mock = vi.fn();
  const onDownloadEvent: Mock = vi.fn(
    (cb: (event: DownloadEvent) => void): (() => void) => {
      listener = cb;
      return unsubscribe;
    },
  );
  return {
    onDownloadEvent,
    unsubscribe,
    emit(event) {
      if (listener === null) {
        throw new Error("onDownloadEvent has not been called yet");
      }
      listener(event);
    },
  };
}

function downloadingEvent(
  downloadJobId: string,
  patch: Partial<{
    progress: number;
    path: string;
    datasourceId: string;
  }>,
): DownloadEvent {
  return {
    kind: "downloading",
    payload: {
      downloadJobId,
      datasourceId: patch.datasourceId ?? "ds-1",
      progress: patch.progress ?? 0,
      path: patch.path ?? "/welcome.pdf",
    },
  };
}

// --- Tests -----------------------------------------------------------

describe("createDownloadJobToaster (§24.1)", () => {
  let toast: MockToast;
  let eventApi: MockEventApi;

  beforeEach(() => {
    toast = makeToast();
    eventApi = makeEventApi();
  });

  it("(a) FIRST downloading event opens a loading toast referencing the basename", () => {
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 25, path: "/folder/welcome.pdf" }),
    );

    expect(toast.loading).toHaveBeenCalledTimes(1);
    const [message, opts] = toast.loading.mock.calls[0] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(message).toContain("welcome.pdf");
    expect(message).toMatch(/25\s*%/);
    expect(opts?.id).toBeDefined();
  });

  it("(b) subsequent downloading events for the SAME id update the SAME toast id", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 10, path: "/welcome.pdf" }),
    );
    eventApi.emit(
      downloadingEvent("job-A", { progress: 60, path: "/welcome.pdf" }),
    );

    expect(toast.loading).toHaveBeenCalledTimes(2);
    const second = toast.loading.mock.calls[1] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(second[1]?.id).toBe("toast-A");
    expect(second[0]).toMatch(/60\s*%/);
  });

  it("(c) terminal file-downloaded fires toast.custom with Show-in-folder + Open actions wired to the preload bridge", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const openSavedPath: Mock = vi.fn(async () => {});
    const showSavedInFolder: Mock = vi.fn(async () => {});

    createDownloadJobToaster({
      toast,
      eventApi,
      filesApi: { openSavedPath, showSavedInFolder },
    });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 50, path: "/welcome.pdf" }),
    );
    eventApi.emit({
      kind: "file-downloaded",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        savedPath: "/Users/alice/Downloads/ft5/welcome.pdf",
        bytes: 2048,
      },
    });

    expect(toast.custom).toHaveBeenCalledTimes(1);
    const [renderFn, opts] = toast.custom.mock.calls[0] as [
      (id: string | number) => unknown,
      { id?: string | number; duration?: number } | undefined,
    ];
    expect(opts?.id).toBe("toast-A");
    expect(typeof opts?.duration).toBe("number");

    // Render the custom toast and assert the action wiring. The render
    // function returns the React element tree; we don't mount it — we
    // just assert on the structure we hand to Sonner.
    const tree = renderFn(opts!.id!);
    expect(tree).toBeDefined();
  });

  it("(c-postsmoke) on file-downloaded after a prior loading toast, dismiss is called BEFORE custom (clears Sonner's loading-variant chrome incl. spinner)", () => {
    // Post-archive smoke (2026-04-28): users reported the success toast
    // mounting alongside a leftover spinner. Root cause: re-using the
    // same toast id with `toast.custom(..., { id })` does NOT clear
    // Sonner's loading-variant template — the spinner is part of the
    // loading template, not our custom render. The fix is an explicit
    // `toast.dismiss(toastId)` before the custom spawn so Sonner tears
    // down the loading chrome before mounting the success render.
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 50, path: "/welcome.pdf" }),
    );
    eventApi.emit({
      kind: "file-downloaded",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        savedPath: "/Users/alice/Downloads/ft5/welcome.pdf",
        bytes: 2048,
      },
    });

    // The dismiss for the loading toast must precede the custom spawn,
    // ordered by invocation. Both calls reference the same toast id.
    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");
    expect(toast.custom).toHaveBeenCalledTimes(1);
    const dismissOrder = toast.dismiss.mock.invocationCallOrder[0]!;
    const customOrder = toast.custom.mock.invocationCallOrder[0]!;
    expect(dismissOrder).toBeLessThan(customOrder);

    // Sanity: the custom render itself does not include a spinner —
    // the success template is plain divs + buttons (Show in folder /
    // Open). Render the tree and assert no role="status" with a
    // spinner indicator, and no "loading" text.
    const [renderFn, opts] = toast.custom.mock.calls[0] as [
      (id: string | number) => unknown,
      { id?: string | number } | undefined,
    ];
    const tree = renderFn(opts!.id!) as {
      type: string;
      props: { role?: string; children?: unknown };
    };
    expect(tree.type).toBe("div");
    // The render is a plain element tree; no "loading"/"spinner"
    // identifier appears anywhere in the className/role surface.
    const serialized = JSON.stringify(tree);
    expect(serialized).not.toMatch(/spinner/i);
    expect(serialized).not.toMatch(/loading/i);
    expect(serialized).toContain("Downloaded");
    expect(serialized).toContain("Open");
    expect(serialized).toContain("Show in folder");
  });

  it("(c-postsmoke-no-prior) on file-downloaded as the FIRST event for a jobId, dismiss is NOT called (nothing to tear down)", () => {
    // Defence against accidentally always-dismissing: when there is no
    // prior loading toast (terminal-as-first-event path, e.g. hydrated
    // jobs that completed before the listener attached), spawning the
    // success toast must not fire a stray dismiss for a non-existent id.
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit({
      kind: "file-downloaded",
      payload: {
        downloadJobId: "job-X",
        datasourceId: "ds-1",
        savedPath: "/Users/alice/Downloads/ft5/welcome.pdf",
        bytes: 2048,
      },
    });

    expect(toast.dismiss).not.toHaveBeenCalled();
    expect(toast.custom).toHaveBeenCalledTimes(1);
  });

  it("(c2) the success toast's [Open] action invokes window.api.files.openSavedPath", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const openSavedPath: Mock = vi.fn(async () => {});
    const showSavedInFolder: Mock = vi.fn(async () => {});

    createDownloadJobToaster({
      toast,
      eventApi,
      filesApi: { openSavedPath, showSavedInFolder },
    });

    eventApi.emit({
      kind: "file-downloaded",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        savedPath: "/Users/alice/Downloads/ft5/welcome.pdf",
        bytes: 2048,
      },
    });

    // The factory exposes the action callbacks so we don't need DOM
    // rendering to verify wiring. They live on the second arg of
    // `toast.custom`.
    const [, opts] = toast.custom.mock.calls[0] as [
      unknown,
      {
        actions?: {
          onOpen: () => void;
          onShowInFolder: () => void;
        };
      },
    ];
    expect(opts.actions).toBeDefined();
    opts.actions!.onOpen();
    expect(openSavedPath).toHaveBeenCalledWith(
      "/Users/alice/Downloads/ft5/welcome.pdf",
    );
    opts.actions!.onShowInFolder();
    expect(showSavedInFolder).toHaveBeenCalledWith(
      "/Users/alice/Downloads/ft5/welcome.pdf",
    );
  });

  it("(d) terminal download-failed fires toast.error with richColors and a Retry action (Infinity duration); Retry click invokes the registered callback", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    const toaster = createDownloadJobToaster({ toast, eventApi });
    const retry: Mock = vi.fn();

    // Orchestrator-side: register the retry BEFORE dispatch, keyed on
    // (datasourceId, sourcePath). The first `downloading` event for the
    // resulting downloadJobId drains the registry entry into the
    // ToastEntry's retry slot.
    toaster.registerRetry("ds-1", "/welcome.pdf", retry);

    eventApi.emit(
      downloadingEvent("job-A", { progress: 10, path: "/welcome.pdf" }),
    );
    eventApi.emit({
      kind: "download-failed",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        tag: "rate-limited",
        message: "rate-limited",
      },
    });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const errorCall = toast.error.mock.calls[0] as [
      string,
      {
        id?: string | number;
        duration?: number;
        richColors?: boolean;
        action?: { label: string; onClick: () => void };
      },
    ];
    expect(errorCall[1].id).toBe("toast-A");
    expect(errorCall[1].duration).toBe(Number.POSITIVE_INFINITY);
    expect(errorCall[1].richColors).toBe(true);
    expect(errorCall[1].action?.label).toMatch(/retry/i);
    expect(typeof errorCall[1].action?.onClick).toBe("function");

    // Click Retry → toast dismisses AND the registered retry fires.
    errorCall[1].action!.onClick();
    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("(d2) when no retry was registered (failure preceded any downloading event), Retry click is dismiss-only", () => {
    toast.error.mockReturnValueOnce("toast-X");
    createDownloadJobToaster({ toast, eventApi });

    // Failure as the FIRST event for this jobId — no `downloading`
    // happened, so no correlation took place.
    eventApi.emit({
      kind: "download-failed",
      payload: {
        downloadJobId: "job-X",
        datasourceId: "ds-1",
        tag: "auth-revoked",
        message: "auth-revoked",
      },
    });

    const errorCall = toast.error.mock.calls[0] as [
      string,
      { action?: { onClick: () => void } },
    ];
    errorCall[1].action!.onClick();
    expect(toast.dismiss).toHaveBeenCalledTimes(1);
  });

  it("(e) terminal download-cancelled silently dismisses the toast", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 25, path: "/welcome.pdf" }),
    );
    eventApi.emit({
      kind: "download-cancelled",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        bytesDownloaded: 256,
        bytesTotal: 1024,
        reason: "user",
      },
    });

    // No success / error variant — just a silent dismiss.
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.custom).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");
  });

  it("(f) two concurrent downloads produce two independent toasts; events for jobId A do not affect jobId B", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    toast.loading.mockReturnValueOnce("toast-B");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 25, path: "/alpha.pdf" }),
    );
    eventApi.emit(
      downloadingEvent("job-B", { progress: 50, path: "/beta.png" }),
    );

    expect(toast.loading).toHaveBeenCalledTimes(2);

    eventApi.emit(
      downloadingEvent("job-A", { progress: 75, path: "/alpha.pdf" }),
    );
    expect(toast.loading).toHaveBeenCalledTimes(3);
    const updateCall = toast.loading.mock.calls[2] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(updateCall[1]?.id).toBe("toast-A");
    expect(updateCall[1]?.id).not.toBe("toast-B");
  });
});

describe("createDownloadJobToaster — hydration (§24.3)", () => {
  let toast: MockToast;
  let eventApi: MockEventApi;

  beforeEach(() => {
    toast = makeToast();
    eventApi = makeEventApi();
  });

  it("(g) hydrateActiveDownloads spawns one toast per DownloadJob with the seeded ratio; live events for the same id update the existing toast", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    toast.loading.mockReturnValueOnce("toast-B");
    const toaster = createDownloadJobToaster({ toast, eventApi });

    const jobs: readonly DownloadJobSummary[] = [
      {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        sourcePath: "/welcome.pdf",
        targetPath: "/Users/alice/Downloads/ft5/welcome.pdf",
        bytesDownloaded: 250,
        contentLength: 1000,
        startedAt: 0,
      },
      {
        downloadJobId: "job-B",
        datasourceId: "ds-1",
        sourcePath: "/another.pdf",
        targetPath: "/Users/alice/Downloads/ft5/another.pdf",
        bytesDownloaded: 0,
        contentLength: null,
        startedAt: 1,
      },
    ];

    toaster.hydrateActiveDownloads(jobs);

    // ONE toast per job, with the seeded percentage.
    expect(toast.loading).toHaveBeenCalledTimes(2);
    const firstA = toast.loading.mock.calls[0] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(firstA[0]).toContain("welcome.pdf");
    expect(firstA[0]).toMatch(/25\s*%/);

    const firstB = toast.loading.mock.calls[1] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(firstB[0]).toContain("another.pdf");
    // null contentLength → 0% (indeterminate)
    expect(firstB[0]).toMatch(/0\s*%/);

    // A subsequent live event for jobId A must update the EXISTING
    // toast id, not spawn a new one.
    eventApi.emit(
      downloadingEvent("job-A", { progress: 50, path: "/welcome.pdf" }),
    );
    expect(toast.loading).toHaveBeenCalledTimes(3);
    const updateCall = toast.loading.mock.calls[2] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(updateCall[1]?.id).toBe("toast-A");
    expect(updateCall[0]).toMatch(/50\s*%/);
  });
});
