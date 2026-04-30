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
  SUCCESS_TOAST_DURATION_MS,
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
    // Post-archive 2026-04-28: the success toast spawns with a FRESH id
    // (`<loadingId>-success`), NOT the loading id. Re-using the loading
    // id raced Sonner's dismiss animation. Assert on the deterministic
    // suffix.
    expect(opts?.id).toBe("toast-A-success");
    expect(opts?.id).not.toBe("toast-A");
    expect(opts?.duration).toBe(Number.POSITIVE_INFINITY);

    // Render the custom toast and assert the action wiring. The render
    // function returns the React element tree; we don't mount it — we
    // just assert on the structure we hand to Sonner.
    const tree = renderFn(opts!.id!);
    expect(tree).toBeDefined();
  });

  it("(c-postsmoke) on file-downloaded after a prior loading toast, dismiss is called BEFORE custom AND custom uses a FRESH id (avoids dismiss-animation race)", () => {
    // Post-archive smoke #1 (2026-04-28 morning): users reported the
    // success toast mounting alongside a leftover spinner. Root cause:
    // re-using the same toast id with `toast.custom(..., { id })` does
    // NOT clear Sonner's loading-variant template — the spinner is part
    // of the loading template, not our custom render. Fix attempt #1
    // added `toast.dismiss(toastId)` before the custom spawn.
    //
    // Post-archive smoke #2 (2026-04-28 afternoon): users then reported
    // the success toast appearing for only ~400-500 ms instead of the
    // configured duration. Root cause: when `toast.custom` is called
    // with the SAME id while Sonner's dismiss animation (~300-400 ms)
    // is still running, the new toast inherits the dismiss state and
    // tears down. Fix #2 (this test): spawn the success on a FRESH id
    // (`<loadingId>-success`) so Sonner has no animation state to
    // inherit.
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

    // The dismiss for the loading id must precede the custom spawn,
    // ordered by invocation. The custom spawn uses a fresh id, distinct
    // from the loading id, so Sonner cannot inherit dismiss-animation
    // state.
    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");
    expect(toast.custom).toHaveBeenCalledTimes(1);
    const customOpts = toast.custom.mock.calls[0]![1] as
      | { id?: string | number }
      | undefined;
    expect(customOpts?.id).toBe("toast-A-success");
    expect(customOpts?.id).not.toBe("toast-A");
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

  it("(c-duration) success toast is sticky (Number.POSITIVE_INFINITY) — the toast IS the affordance; auto-dismiss would defeat the dual-action layout", () => {
    // Progression of the duration constant:
    //   - Initial: 4000 ms (mirroring upload's fire-and-forget pattern).
    //   - 2026-04-29: 8000 ms after user feedback that 4 s was too short
    //     to register the toast and click an action.
    //   - 2026-04-28 (this fix): Number.POSITIVE_INFINITY (sticky).
    //     Rationale: download's success toast IS the affordance. The
    //     dual-action layout (Show in folder + Open) explicitly invites
    //     a user click; auto-dismissing it defeats the point. The user
    //     dismisses it by clicking an action (handlers wired to
    //     `toast.dismiss(successId)`) or via Sonner's close-button X
    //     (sticky toasts surface it by default).
    //
    // This test pins (1) the call carries an explicit `duration`,
    // (2) it equals the exported constant, and (3) the constant is
    // Number.POSITIVE_INFINITY.
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

    expect(toast.custom).toHaveBeenCalledTimes(1);
    const [, opts] = toast.custom.mock.calls[0] as [
      unknown,
      { id?: string | number; duration?: number } | undefined,
    ];
    expect(opts?.duration).toBeDefined();
    expect(opts?.duration).toBe(SUCCESS_TOAST_DURATION_MS);
    // Defence-in-depth: pin the constant to the sticky sentinel so any
    // silent bump back to a finite value surfaces here instead of in
    // user-perceived UX.
    expect(SUCCESS_TOAST_DURATION_MS).toBe(Number.POSITIVE_INFINITY);
  });

  it("(c-dismiss-on-open) clicking [Open] dismisses the success toast (clears the affordance once consumed)", () => {
    // Sticky success toasts must self-dismiss when the user acts —
    // otherwise a stale "Downloaded" toast hangs around after the user
    // already opened the file. The handler calls
    // `toast.dismiss(successId)` AFTER invoking the user-supplied
    // bridge call.
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

    const [, opts] = toast.custom.mock.calls[0] as [
      unknown,
      {
        id?: string | number;
        actions?: { onOpen: () => void; onShowInFolder: () => void };
      },
    ];
    const successId = opts.id;
    expect(successId).toBe("toast-A-success");

    // Clear the dismiss recorded by the loading→success teardown so
    // the assertion below pins the dismiss-on-action specifically.
    toast.dismiss.mockClear();

    opts.actions!.onOpen();
    expect(openSavedPath).toHaveBeenCalledWith(
      "/Users/alice/Downloads/ft5/welcome.pdf",
    );
    expect(toast.dismiss).toHaveBeenCalledWith(successId);
  });

  it("(c-dismiss-on-show) clicking [Show in folder] dismisses the success toast", () => {
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

    const [, opts] = toast.custom.mock.calls[0] as [
      unknown,
      {
        id?: string | number;
        actions?: { onOpen: () => void; onShowInFolder: () => void };
      },
    ];
    const successId = opts.id;
    toast.dismiss.mockClear();

    opts.actions!.onShowInFolder();
    expect(showSavedInFolder).toHaveBeenCalledWith(
      "/Users/alice/Downloads/ft5/welcome.pdf",
    );
    expect(toast.dismiss).toHaveBeenCalledWith(successId);
  });

  it("(c-duplicate-terminal) duplicate file-downloaded for the same downloadJobId does NOT re-spawn the success toast (terminal-marker guard)", () => {
    // Regression guard: the spawn-tracker marks the entry `terminal:
    // true` after the first terminal event. A duplicate `file-
    // downloaded` (or a late `download-failed`) for the same jobId
    // must short-circuit instead of resurrecting a dismissed toast or
    // racing Sonner's animation state.
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

    expect(toast.custom).toHaveBeenCalledTimes(1);

    // Duplicate file-downloaded — must be a no-op.
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

    // Late download-failed for the same jobId — also a no-op (the
    // tracker entry is terminal).
    eventApi.emit({
      kind: "download-failed",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        tag: "other",
        message: "stale event",
      },
    });
    expect(toast.error).not.toHaveBeenCalled();
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

// --- add-download-resilience §8 — retrying-state tests --------------

function retryingEvent(
  downloadJobId: string,
  patch: Partial<{
    attempt: number;
    limit: number;
    waitMs: number;
    engineCause: string;
    datasourceId: string;
  }> = {},
): DownloadEvent {
  return {
    kind: "download-retrying",
    payload: {
      downloadJobId,
      datasourceId: patch.datasourceId ?? "ds-1",
      attempt: patch.attempt ?? 2,
      limit: patch.limit ?? 5,
      waitMs: patch.waitMs ?? 4000,
      engineCause: patch.engineCause ?? "network-error",
    },
  };
}

function serializeTree(tree: unknown): string {
  // The render fn returns a React element tree built via React.createElement
  // (no JSX). Its props/children are plain JS values, so JSON.stringify
  // exposes the rendered text and attributes for content assertions.
  return JSON.stringify(tree);
}

interface ReactNodeShape {
  readonly type?: string;
  readonly props?: {
    readonly children?: unknown;
    readonly onClick?: () => void;
    readonly [k: string]: unknown;
  };
}

/**
 * Walk a React.createElement tree (the kind `buildFailureRender` /
 * `buildSuccessRender` produce — plain object nodes, not mounted DOM)
 * and return the first `<button>` whose text content includes `text`.
 * Used by `(8.cov-2)` to extract and invoke the Retry button's onClick
 * without mounting the tree.
 */
function findButtonByText(
  node: unknown,
  text: string,
): ReactNodeShape | null {
  if (node === null || typeof node !== "object") return null;
  const candidate = node as ReactNodeShape;
  const kids = candidate.props?.children;
  if (
    candidate.type === "button" &&
    JSON.stringify(kids ?? "").includes(text)
  ) {
    return candidate;
  }
  if (Array.isArray(kids)) {
    for (const child of kids) {
      const found = findButtonByText(child, text);
      if (found !== null) return found;
    }
  } else if (kids !== undefined && kids !== null) {
    return findButtonByText(kids, text);
  }
  return null;
}

describe("createDownloadJobToaster — retrying state (§8)", () => {
  let toast: MockToast;
  let eventApi: MockEventApi;

  beforeEach(() => {
    toast = makeToast();
    eventApi = makeEventApi();
  });

  it("(8.1) on download-retrying, toast switches to a custom render with Reconnecting subtext + spinner glyph", () => {
    // Drive a downloading toast to ~62%, then dispatch the retry event.
    // Expect the toast to switch to `toast.custom(...)` with:
    //   - title "Downloading welcome.pdf"
    //   - subtext "Reconnecting… (2/5)"
    //   - a spinner glyph identifier (data-test="retrying-spinner") in
    //     place of the percentage indicator
    //   - the SAME toast id as the loading toast (so progress-bar position
    //     sits at the last-rendered byte position; Sonner re-uses the
    //     same id slot for the visual update)
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 62, path: "/welcome.pdf" }),
    );
    eventApi.emit(retryingEvent("job-A", { attempt: 2, limit: 5 }));

    expect(toast.custom).toHaveBeenCalledTimes(1);
    const [renderFn, opts] = toast.custom.mock.calls[0] as [
      (id: string | number) => unknown,
      { id?: string | number; duration?: number } | undefined,
    ];
    // Same id as the loading toast — Sonner updates the same toast slot.
    expect(opts?.id).toBe("toast-A");
    const tree = renderFn(opts!.id!);
    const serialized = serializeTree(tree);
    expect(serialized).toContain("Downloading welcome.pdf");
    expect(serialized).toContain("Reconnecting");
    expect(serialized).toContain("2/5");
    // Spinner glyph identifier — pinned via data-test attribute so the
    // assertion does not depend on the specific Tailwind icon family.
    expect(serialized).toContain("retrying-spinner");
    // Spec: percentage indicator is REPLACED by the spinner — make sure
    // the subtext does not still carry "62%".
    expect(serialized).not.toMatch(/62\s*%/);
  });

  it("(8.2) next downloading event after retrying snaps back to loading (toast.loading with new percentage)", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 62, path: "/welcome.pdf" }),
    );
    eventApi.emit(retryingEvent("job-A", { attempt: 2, limit: 5 }));
    expect(toast.custom).toHaveBeenCalledTimes(1);

    // Bytes flowing again — the next downloading event reverts the toast
    // to the standard loading template with the new percentage.
    toast.loading.mockClear();
    eventApi.emit(
      downloadingEvent("job-A", { progress: 63, path: "/welcome.pdf" }),
    );
    expect(toast.loading).toHaveBeenCalledTimes(1);
    const [msg, opts] = toast.loading.mock.calls[0] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(opts?.id).toBe("toast-A");
    expect(msg).toMatch(/63\s*%/);
    expect(msg).toContain("welcome.pdf");
    // No new toast.custom — the retry-state custom render was for the
    // retrying event only; the loading template handles the resume.
    expect(toast.custom).toHaveBeenCalledTimes(1);
  });

  it("(8.3) retrying-state custom render carries a tooltip with engineCause + waitMs", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 62, path: "/welcome.pdf" }),
    );
    eventApi.emit(
      retryingEvent("job-A", {
        attempt: 2,
        limit: 5,
        waitMs: 4000,
        engineCause: "network-error",
      }),
    );

    const [renderFn, opts] = toast.custom.mock.calls[0] as [
      (id: string | number) => unknown,
      { id?: string | number } | undefined,
    ];
    const tree = renderFn(opts!.id!) as {
      props: { title?: string; [k: string]: unknown };
    };
    // The wrapping element exposes the diagnostic tooltip via the
    // `title` HTML attribute (browsers render this on hover natively;
    // no library required).
    expect(typeof tree.props.title).toBe("string");
    expect(tree.props.title).toContain("network-error");
    expect(tree.props.title).toContain("4000");
  });

  it("(8.4) toast does NOT enter retrying state without a download-retrying event (auth-expired Layer 2 retry stays invisible)", () => {
    // Auth-expired retries do not emit `download-retrying`. The
    // renderer sees an interruption only as a gap in `downloading`
    // events — the toast must NOT flip to the custom retrying render
    // in that case.
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 50, path: "/welcome.pdf" }),
    );
    eventApi.emit(
      downloadingEvent("job-A", { progress: 60, path: "/welcome.pdf" }),
    );
    eventApi.emit(
      downloadingEvent("job-A", { progress: 70, path: "/welcome.pdf" }),
    );

    // Custom is reserved for retrying / success-style renders — without
    // a download-retrying event, only toast.loading should fire.
    expect(toast.custom).not.toHaveBeenCalled();
    expect(toast.loading).toHaveBeenCalledTimes(3);
  });

  it("(8.5) download-cancelled during retrying state dismisses the toast (existing cancel path remains the path forward)", () => {
    // Adapted from spec scenario "Cancel during retry sleep dismisses
    // toast within 100ms". The toast has no Cancel button today; the
    // spec preserves the cancel path "exactly as it does in downloading
    // state" — i.e. the renderer's existing dismiss-on-cancelled-event
    // wiring. This test confirms the wiring still applies in retrying
    // state: when `download-cancelled` arrives after a retry render,
    // the toast dismisses with the SAME id that was rendered.
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 62, path: "/welcome.pdf" }),
    );
    eventApi.emit(retryingEvent("job-A", { attempt: 2, limit: 5 }));
    expect(toast.custom).toHaveBeenCalledTimes(1);

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

    // Existing cancel path: dismiss the toast id, no error / success
    // variants emitted.
    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("(8.6) hydration → retrying: hydrated toast transitions through downloading → retrying on next download-retrying event", () => {
    toast.loading.mockReturnValueOnce("hydrated-A");
    const toaster = createDownloadJobToaster({ toast, eventApi });

    toaster.hydrateActiveDownloads([
      {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        sourcePath: "/welcome.pdf",
        targetPath: "/Users/alice/Downloads/ft5/welcome.pdf",
        bytesDownloaded: 251_658_240,
        contentLength: 398_458_880,
        startedAt: 0,
      },
    ]);
    expect(toast.loading).toHaveBeenCalledTimes(1);

    // Service-side retry sleep is in progress — the next event for this
    // jobId is a retrying event, not a downloading one.
    eventApi.emit(
      retryingEvent("job-A", {
        attempt: 3,
        limit: 5,
        waitMs: 4000,
        engineCause: "network-error",
      }),
    );

    expect(toast.custom).toHaveBeenCalledTimes(1);
    const [renderFn, opts] = toast.custom.mock.calls[0] as [
      (id: string | number) => unknown,
      { id?: string | number } | undefined,
    ];
    expect(opts?.id).toBe("hydrated-A");
    const serialized = serializeTree(renderFn(opts!.id!));
    expect(serialized).toContain("3/5");
    expect(serialized).toContain("Reconnecting");
  });

  it("(8.7) hydration → downloading: hydrated toast continues as loading on next downloading event (no retrying state)", () => {
    toast.loading.mockReturnValueOnce("hydrated-A");
    const toaster = createDownloadJobToaster({ toast, eventApi });

    toaster.hydrateActiveDownloads([
      {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        sourcePath: "/welcome.pdf",
        targetPath: "/Users/alice/Downloads/ft5/welcome.pdf",
        bytesDownloaded: 100,
        contentLength: 200,
        startedAt: 0,
      },
    ]);
    expect(toast.loading).toHaveBeenCalledTimes(1);

    // Bytes were already flowing when the renderer connected — the
    // first event is a downloading update.
    eventApi.emit(
      downloadingEvent("job-A", { progress: 64, path: "/welcome.pdf" }),
    );

    // No retrying-state custom render.
    expect(toast.custom).not.toHaveBeenCalled();
    // The hydrated toast id keeps receiving loading updates.
    expect(toast.loading).toHaveBeenCalledTimes(2);
    const [msg, opts] = toast.loading.mock.calls[1] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(opts?.id).toBe("hydrated-A");
    expect(msg).toMatch(/64\s*%/);
  });

  it("(8.8) failure-toast handles tag: 'exhausted-retries' — renders existing failed appearance with verbatim message", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 50, path: "/welcome.pdf" }),
    );
    eventApi.emit({
      kind: "download-failed",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        tag: "exhausted-retries",
        message: "exhausted-retries: network-error",
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
    // Verbatim message text appears in the rendered failure toast.
    expect(errorCall[0]).toContain("exhausted-retries: network-error");
    // Existing failed appearance is preserved (red, sticky, Retry).
    expect(errorCall[1].id).toBe("toast-A");
    expect(errorCall[1].duration).toBe(Number.POSITIVE_INFINITY);
    expect(errorCall[1].richColors).toBe(true);
    expect(errorCall[1].action?.label).toMatch(/retry/i);
  });

  it("(8.cov-1) download-retrying as the FIRST event for an unseen jobId spawns a custom toast with a freshly-minted id and the default 'download' basename", () => {
    // Pins the defensive code path at download-job-toast.ts where
    // `tracker.get(downloadJobId)` returns undefined and the handler
    // falls back to a fresh id + default basename. Reachable in
    // production if a hydrated download immediately receives a retry
    // event without an intervening `downloading` event, or in any
    // ordering where the bridge delivers retrying before downloading.
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(retryingEvent("job-X", { attempt: 1, limit: 5 }));

    expect(toast.custom).toHaveBeenCalledTimes(1);
    const [renderFn, opts] = toast.custom.mock.calls[0] as [
      (id: string | number) => unknown,
      { id?: string | number } | undefined,
    ];
    // Freshly-minted id (pattern is `download-toast-<n>`); not a stub
    // value because no prior loading toast minted one.
    expect(opts?.id).toMatch(/^download-toast-\d+$/);
    const tree = renderFn(opts!.id!);
    const serialized = serializeTree(tree);
    // Default fallback basename when no `downloading` event preceded.
    expect(serialized).toContain("Downloading download");
    expect(serialized).toContain("Reconnecting");
    expect(serialized).toContain("1/5");
  });

  it("(8.cov-2) retrying → failed: render-mode swap stays on the SAME id (custom→custom in-place replace)", () => {
    // §11.10 iteration-1 smoke (post commit `f456678`): the dismiss-
    // then-fresh-id approach passed mock tests because `toast.dismiss`
    // is synchronous in tests but loses to Sonner's dismiss animation
    // in real runtime — both retrying-render and error-render were
    // visible simultaneously.
    //
    // §11.12-§11.14 iteration-2 fix: when `existing.retrying === true`,
    // switch render mode within `toast.custom` on the SAME id. Sonner
    // handles same-id same-mode swaps in-place with no animation
    // transition. ONE toast in the slot.
    //
    // The loading→failed (no retrying) path stays on `toast.error` —
    // that's a Sonner built-in type swap that has worked reliably
    // forever (see (8.cov-3) regression guard).
    toast.loading.mockReturnValueOnce("toast-A");
    const retryFn = vi.fn();
    const t = createDownloadJobToaster({ toast, eventApi });
    t.registerRetry("ds-1", "/welcome.pdf", retryFn);

    eventApi.emit(
      downloadingEvent("job-A", { progress: 50, path: "/welcome.pdf" }),
    );
    eventApi.emit(retryingEvent("job-A", { attempt: 3, limit: 5 }));
    expect(toast.custom).toHaveBeenCalledTimes(1); // retrying-state custom render

    eventApi.emit({
      kind: "download-failed",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        tag: "exhausted-retries",
        message: "exhausted-retries: network-error",
      },
    });

    // Failure render is ALSO toast.custom (not toast.error) so Sonner's
    // same-id custom→custom in-place swap kicks in. ONE toast in the
    // slot. toast.error is NOT called for the retrying-then-failed
    // path; toast.dismiss is NOT called pre-spawn (the in-place swap
    // replaces without dismissing).
    expect(toast.custom).toHaveBeenCalledTimes(2); // retrying + failure
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.dismiss).not.toHaveBeenCalled();

    const [renderFn, opts] = toast.custom.mock.calls[1] as [
      (id: string | number) => unknown,
      { id?: string | number; duration?: number },
    ];
    // SAME id as the retrying-state render; no `-failed` suffix.
    expect(opts?.id).toBe("toast-A");
    expect(opts?.duration).toBe(Number.POSITIVE_INFINITY);

    const tree = renderFn(opts!.id!);
    const serialized = serializeTree(tree);
    expect(serialized).toContain("Download failed");
    expect(serialized).toContain("exhausted-retries: network-error");
    expect(serialized).toContain("Retry");

    // Retry callback registered pre-dispatch survives the
    // downloading → retrying → failed transition. Clicking the Retry
    // button in the rendered tree invokes the original orchestrator
    // callback AND dismisses the failure toast.
    const retryButton = findButtonByText(tree, "Retry");
    expect(retryButton).not.toBeNull();
    retryButton!.props.onClick();
    expect(retryFn).toHaveBeenCalledTimes(1);
    // Dismiss-on-retry-click targets the same id (the custom-render id).
    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");
  });

  it("(8.cov-3) downloading → failed (no retrying state) stays on the same id (no fresh-id derivation)", () => {
    // Regression guard for the non-broken transition path: when
    // there's no prior `download-retrying`, the previous render is
    // the loading template. `toast.error(msg, { id })` after
    // `toast.loading` updates in-place because Sonner's loading and
    // error variants share a slot — no fresh-id derivation needed.
    //
    // This test pins that the §11.5 fix only branches when
    // `existing.retrying === true` and leaves the simpler
    // loading→error path untouched (the (d) and (8.8) tests already
    // cover this; (8.cov-3) is the explicit regression marker for
    // the §11.5 conditional).
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 50, path: "/welcome.pdf" }),
    );
    eventApi.emit({
      kind: "download-failed",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        tag: "other",
        message: "boom",
      },
    });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const errorCall = toast.error.mock.calls[0] as [
      string,
      { id?: string | number },
    ];
    // Same id as the loading toast — no dismiss-then-respawn for the
    // loading→error transition (only the custom→error case needs that).
    expect(errorCall[1].id).toBe("toast-A");
    // No pre-spawn dismiss of the loading id (the in-place update
    // pattern is intact for this transition).
    expect(toast.dismiss).not.toHaveBeenCalledWith("toast-A");
  });
});
