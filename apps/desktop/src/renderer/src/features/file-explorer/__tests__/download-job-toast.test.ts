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
  type SyncActionsApi,
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
    (
      _msg: string,
      opts?: {
        id?: string | number;
        description?: string;
        // §12.2: Sonner's `toast.loading` accepts an `action` option for
        // the built-in template's Cancel button. The mock captures it
        // so tests can assert on label + onClick.
        action?: { label: string; onClick: () => void };
      },
    ) => opts?.id ?? `toast-${next++}`,
  );
  const success: Mock = vi.fn(
    (_msg: string, opts?: { id?: string | number }) =>
      opts?.id ?? `toast-${next++}`,
  );
  const error: Mock = vi.fn(
    (_msg: string, opts?: { id?: string | number; description?: string }) =>
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

interface MockSyncApi extends SyncActionsApi {
  cancelJob: Mock;
}

function makeSyncApi(): MockSyncApi {
  // Default impl resolves with a no-op envelope. Tests that assert the
  // call wiring inspect `cancelJob.mock.calls`. Tests that don't care
  // can pass this through to the toaster as a noop.
  const cancelJob: Mock = vi.fn(async (_req: { downloadJobId: string }) => ({
    ok: true,
    result: { cancelled: true },
  }));
  return { cancelJob };
}

function downloadingEvent(
  downloadJobId: string,
  patch: Partial<{
    progress: number;
    path: string;
    datasourceId: string;
    bytesLoaded: number;
    bytesTotal: number | null;
  }>,
): DownloadEvent {
  // §12.3: synthesize bytesLoaded + bytesTotal from progress when callers
  // don't supply them explicitly. Tests that only care about `progress`
  // (the historical majority) still work; tests that exercise the
  // bytes-only fallback path supply explicit values.
  const bytesTotal = patch.bytesTotal === undefined ? 1_000_000 : patch.bytesTotal;
  const progress = patch.progress ?? 0;
  const bytesLoaded =
    patch.bytesLoaded ??
    (bytesTotal !== null && bytesTotal > 0
      ? Math.floor((progress / 100) * bytesTotal)
      : 0);
  return {
    kind: "downloading",
    payload: {
      downloadJobId,
      datasourceId: patch.datasourceId ?? "ds-1",
      progress,
      path: patch.path ?? "/welcome.pdf",
      bytesLoaded,
      bytesTotal,
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
    // §12.3 (Decision 14): null contentLength → bytes-only fallback.
    // Seeded with `bytesDownloaded: 0` → "0.0 MB" instead of "0%".
    expect(firstB[0]).toMatch(/0\.0\s*MB/);

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

describe("createDownloadJobToaster — retrying state (§8)", () => {
  let toast: MockToast;
  let eventApi: MockEventApi;

  beforeEach(() => {
    toast = makeToast();
    eventApi = makeEventApi();
  });

  it("(8.1) on download-retrying, toast.loading is reissued on the SAME id with the Reconnecting message + diagnostic description (NO toast.custom)", () => {
    // Iter-3 (post §11.16): retrying state uses `toast.loading` —
    // same render mode as the downloading template. Title swaps from
    // `Downloading welcome.pdf — 62%` to `Downloading welcome.pdf —
    // Reconnecting (2/5)`. Diagnostic context (`engineCause`, `waitMs`)
    // renders as Sonner's `description` field (always-visible, not
    // hover-only — Decision 5 v2). Spinner glyph comes from Sonner's
    // built-in loading template natively (no test assertion needed).
    //
    // Iter-2 used `toast.custom` here; that path is abandoned because
    // Sonner's `Observer.create()` carries `type: 'loading'` over to
    // the custom render, leaving the spinner-chrome overlay on top.
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

    // No toast.custom for the retrying state.
    expect(toast.custom).not.toHaveBeenCalled();
    // Two toast.loading calls: initial (62%) + retrying.
    expect(toast.loading).toHaveBeenCalledTimes(2);
    const [msg, opts] = toast.loading.mock.calls[1] as [
      string,
      { id?: string | number; description?: string } | undefined,
    ];
    // SAME id as the initial loading toast — Sonner updates the same slot.
    expect(opts?.id).toBe("toast-A");
    // Title swaps from percentage to Reconnecting (n/limit).
    expect(msg).toContain("Downloading welcome.pdf");
    expect(msg).toContain("Reconnecting");
    expect(msg).toContain("2/5");
    // Title no longer carries the percentage.
    expect(msg).not.toMatch(/62\s*%/);
    // Description carries diagnostic context.
    expect(typeof opts?.description).toBe("string");
    expect(opts?.description).toContain("network-error");
    expect(opts?.description).toContain("4000");
  });

  it("(8.2) next downloading event after retrying snaps back to the percentage message AND clears the description (defeats Sonner-merge of stale diagnostic text)", () => {
    // Sonner's `Observer.create()` merges new toast data over the
    // existing toast: `{ ...oldToast, ...newData }`. The retrying call
    // set `description: "Last error: …"`. Without an explicit clear,
    // the resume `toast.loading(msg, { id })` would inherit the prior
    // description (oldToast.description survives the spread when newData
    // doesn't include the key). Production must pass
    // `description: ""` (falsy → view-layer hides the row) on resume.
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 62, path: "/welcome.pdf" }),
    );
    eventApi.emit(retryingEvent("job-A", { attempt: 2, limit: 5 }));

    // Bytes flowing again — the next downloading event reverts the toast
    // to the percentage form on the same id.
    toast.loading.mockClear();
    eventApi.emit(
      downloadingEvent("job-A", { progress: 63, path: "/welcome.pdf" }),
    );

    expect(toast.loading).toHaveBeenCalledTimes(1);
    const [msg, opts] = toast.loading.mock.calls[0] as [
      string,
      { id?: string | number; description?: string } | undefined,
    ];
    expect(opts?.id).toBe("toast-A");
    expect(msg).toMatch(/63\s*%/);
    expect(msg).toContain("welcome.pdf");
    // Description must be a falsy value to clear the prior retrying-
    // state description from Sonner's merged toast data. Empty string
    // is preferred — `toast.description ?` in the view layer treats
    // it as falsy and hides the row.
    expect(opts).toHaveProperty("description");
    expect(opts?.description).toBe("");
    expect(toast.custom).not.toHaveBeenCalled();
  });

  it("(8.3) retrying-state toast.loading description carries engineCause + waitMs (always-visible diagnostic, not hover tooltip)", () => {
    // Decision 5 ratified in iter-3: the original "tooltip on hover"
    // contract was abandoned — `toast.custom` couldn't reliably
    // replace the loading-template chrome. Diagnostic info now lives
    // in Sonner's `description` field, which renders below the title
    // in the toast body and is always visible.
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

    const [, opts] = toast.loading.mock.calls[1] as [
      string,
      { description?: string },
    ];
    expect(typeof opts.description).toBe("string");
    expect(opts.description).toContain("network-error");
    expect(opts.description).toContain("4000");
  });

  it("(8.4) toast does NOT enter retrying state without a download-retrying event (auth-expired Layer 2 retry stays invisible)", () => {
    // Auth-expired retries do not emit `download-retrying`. The
    // renderer sees an interruption only as a gap in `downloading`
    // events — the toast must stay on the percentage message; no
    // Reconnecting subtext should appear.
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

    expect(toast.custom).not.toHaveBeenCalled();
    expect(toast.loading).toHaveBeenCalledTimes(3);
    for (const call of toast.loading.mock.calls) {
      const [msg] = call as [string, unknown];
      expect(msg).not.toContain("Reconnecting");
    }
  });

  it("(8.5) download-cancelled during retrying state dismisses the toast on the same id", () => {
    // Spec scenario "Cancel during retry sleep dismisses toast within
    // 100ms". §12.2 (iter-4) made the toast's Cancel UI button real
    // (Decision 13) — the click fires `syncApi.cancelJob` which causes
    // the service to emit `download-cancelled`. This test pins the
    // event-arrival half of that round-trip: when `download-cancelled`
    // arrives after a retry render, the toast dismisses with the SAME
    // id that was rendered. The click-fires-cancelJob half is covered
    // by `(12.2.6)` / `(12.2.7)`.
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 62, path: "/welcome.pdf" }),
    );
    eventApi.emit(retryingEvent("job-A", { attempt: 2, limit: 5 }));

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

    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.custom).not.toHaveBeenCalled();
  });

  it("(8.6) hydration → retrying: hydrated toast transitions through downloading → retrying via toast.loading on the same id", () => {
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

    // No toast.custom for retrying state in iter-3.
    expect(toast.custom).not.toHaveBeenCalled();
    // Hydration call + retrying call on the same id.
    expect(toast.loading).toHaveBeenCalledTimes(2);
    const [msg, opts] = toast.loading.mock.calls[1] as [
      string,
      { id?: string | number; description?: string } | undefined,
    ];
    expect(opts?.id).toBe("hydrated-A");
    expect(msg).toContain("3/5");
    expect(msg).toContain("Reconnecting");
    expect(opts?.description).toContain("network-error");
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

    expect(toast.custom).not.toHaveBeenCalled();
    expect(toast.loading).toHaveBeenCalledTimes(2);
    const [msg, opts] = toast.loading.mock.calls[1] as [
      string,
      { id?: string | number } | undefined,
    ];
    expect(opts?.id).toBe("hydrated-A");
    expect(msg).toMatch(/64\s*%/);
    expect(msg).not.toContain("Reconnecting");
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

  it("(8.cov-1) download-retrying as the FIRST event for an unseen jobId spawns toast.loading on a freshly-minted id with the default 'download' basename", () => {
    // Pins the defensive code path at download-job-toast.ts where
    // `tracker.get(downloadJobId)` returns undefined and the handler
    // falls back to a fresh id + default basename. Reachable in
    // production if a hydrated download immediately receives a retry
    // event without an intervening `downloading` event, or in any
    // ordering where the bridge delivers retrying before downloading.
    createDownloadJobToaster({ toast, eventApi });

    eventApi.emit(retryingEvent("job-X", { attempt: 1, limit: 5 }));

    expect(toast.custom).not.toHaveBeenCalled();
    expect(toast.loading).toHaveBeenCalledTimes(1);
    const [msg, opts] = toast.loading.mock.calls[0] as [
      string,
      { id?: string | number; description?: string } | undefined,
    ];
    // Freshly-minted id (pattern is `download-toast-<n>`); not a stub
    // value because no prior loading toast minted one.
    expect(opts?.id).toMatch(/^download-toast-\d+$/);
    expect(msg).toContain("Downloading download");
    expect(msg).toContain("Reconnecting");
    expect(msg).toContain("1/5");
    expect(typeof opts?.description).toBe("string");
  });

  it("(8.cov-2) retrying → failed: toast.loading then toast.error on the SAME id (loading→error built-in type swap), with description cleared on the failure call", () => {
    // Iter-3 (§11.16): both retrying and failure use Sonner built-in
    // templates. The retrying state used `toast.loading` (with a
    // description). The failure call MUST clear that description —
    // Sonner's `Observer.create()` merges new data over the existing
    // toast, so without an explicit `description: ""` the failure
    // toast would inherit the retrying-state diagnostic text.
    //
    // No `toast.custom` is involved at any point. Sonner's
    // loading→error built-in type swap is reliable on the same id
    // (pinned by tests `(d)`, `(d2)`, `(8.cov-3)`).
    toast.loading.mockReturnValueOnce("toast-A");
    const retryFn = vi.fn();
    const t = createDownloadJobToaster({ toast, eventApi });
    t.registerRetry("ds-1", "/welcome.pdf", retryFn);

    eventApi.emit(
      downloadingEvent("job-A", { progress: 50, path: "/welcome.pdf" }),
    );
    eventApi.emit(retryingEvent("job-A", { attempt: 3, limit: 5 }));
    expect(toast.loading).toHaveBeenCalledTimes(2);

    eventApi.emit({
      kind: "download-failed",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        tag: "exhausted-retries",
        message: "exhausted-retries: network-error",
      },
    });

    // No toast.custom anywhere. No pre-spawn dismiss (loading→error
    // is a Sonner built-in type swap; same id replaces in place).
    expect(toast.custom).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.dismiss).not.toHaveBeenCalled();

    const errorCall = toast.error.mock.calls[0] as [
      string,
      {
        id?: string | number;
        duration?: number;
        richColors?: boolean;
        description?: string;
        action?: { label: string; onClick: () => void };
      },
    ];
    expect(errorCall[0]).toContain("Download failed");
    expect(errorCall[0]).toContain("exhausted-retries: network-error");
    expect(errorCall[1].id).toBe("toast-A");
    expect(errorCall[1].duration).toBe(Number.POSITIVE_INFINITY);
    expect(errorCall[1].richColors).toBe(true);
    // Description must be cleared so Sonner's merge doesn't carry the
    // retrying-state diagnostic ("Last error: network-error. Waiting
    // 4000ms before retry.") onto the failure toast.
    expect(errorCall[1]).toHaveProperty("description");
    expect(errorCall[1].description).toBe("");
    expect(errorCall[1].action?.label).toMatch(/retry/i);

    // Retry callback registered pre-dispatch survives the
    // downloading → retrying → failed transition.
    errorCall[1].action!.onClick();
    expect(retryFn).toHaveBeenCalledTimes(1);
    expect(toast.dismiss).toHaveBeenCalledWith("toast-A");
  });

  it("(8.cov-3) downloading → failed (no retrying state) stays on the same id (no fresh-id derivation)", () => {
    // Regression guard for the non-broken transition path: when
    // there's no prior `download-retrying`, the previous render is
    // the loading template. `toast.error(msg, { id })` after
    // `toast.loading` updates in-place because Sonner's loading→error
    // built-in type swap is reliable on the same id.
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
    expect(errorCall[1].id).toBe("toast-A");
    expect(toast.dismiss).not.toHaveBeenCalledWith("toast-A");
  });
});

// §12.2 — Cancel action button on the active download toast (Decision 13).
// The toaster injects `action: { label: "Cancel", onClick }` into both
// the downloading-state and retrying-state `toast.loading` calls. Click
// fires `syncApi.cancelJob({ downloadJobId })` (fire-and-forget); the
// subsequent `download-cancelled` IPC event is what actually dismisses
// the toast through the existing event-handler path.
describe("createDownloadJobToaster — Cancel action (§12.2)", () => {
  let toast: MockToast;
  let eventApi: MockEventApi;
  let syncApi: MockSyncApi;

  beforeEach(() => {
    toast = makeToast();
    eventApi = makeEventApi();
    syncApi = makeSyncApi();
  });

  it("(12.2.6) downloading-state toast carries a Cancel action wired to syncApi.cancelJob", () => {
    createDownloadJobToaster({ toast, eventApi, syncApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 42, path: "/welcome.pdf" }),
    );

    expect(toast.loading).toHaveBeenCalledTimes(1);
    const loadingCall = toast.loading.mock.calls[0] as [
      string,
      {
        id?: string | number;
        action?: { label: string; onClick: () => void };
      },
    ];
    expect(loadingCall[1].action).toBeDefined();
    expect(loadingCall[1].action!.label).toBe("Cancel");
    expect(typeof loadingCall[1].action!.onClick).toBe("function");

    // Click the Cancel action → cancelJob fires with the right
    // downloadJobId. Fire-and-forget: the click does NOT wait on the
    // Promise.
    loadingCall[1].action!.onClick();
    expect(syncApi.cancelJob).toHaveBeenCalledTimes(1);
    expect(syncApi.cancelJob).toHaveBeenCalledWith({ downloadJobId: "job-A" });
  });

  it("(12.2.7) retrying-state toast carries a Cancel action on the SAME id, wired to the same downloadJobId", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi, syncApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 62, path: "/welcome.pdf" }),
    );
    eventApi.emit({
      kind: "download-retrying",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        attempt: 2,
        limit: 5,
        waitMs: 4000,
        engineCause: "network-error",
      },
    });

    expect(toast.loading).toHaveBeenCalledTimes(2);
    const retryingCall = toast.loading.mock.calls[1] as [
      string,
      {
        id?: string | number;
        action?: { label: string; onClick: () => void };
      },
    ];
    expect(retryingCall[1].id).toBe("toast-A");
    expect(retryingCall[1].action).toBeDefined();
    expect(retryingCall[1].action!.label).toBe("Cancel");

    retryingCall[1].action!.onClick();
    expect(syncApi.cancelJob).toHaveBeenCalledWith({ downloadJobId: "job-A" });
  });

  it("(12.2.8) Cancel-action click does NOT pre-emptively dismiss the toast (the dismiss flows through the download-cancelled event)", () => {
    createDownloadJobToaster({ toast, eventApi, syncApi });
    eventApi.emit(
      downloadingEvent("job-A", { progress: 50, path: "/welcome.pdf" }),
    );

    const loadingCall = toast.loading.mock.calls[0] as [
      string,
      { action?: { onClick: () => void } },
    ];
    loadingCall[1].action!.onClick();

    // toast.dismiss SHALL NOT be invoked by the click handler. The
    // service's existing `download-cancelled` event handler (silent
    // dismiss) does that work in response to the eventual cancel
    // confirmation.
    expect(toast.dismiss).not.toHaveBeenCalled();
  });

  it("(12.2.9) failure-state toast does NOT render a Cancel action — only the existing Retry action", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi, syncApi });

    eventApi.emit(
      downloadingEvent("job-A", { progress: 10, path: "/welcome.pdf" }),
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
      { action?: { label: string } },
    ];
    expect(errorCall[1].action).toBeDefined();
    expect(errorCall[1].action!.label).toMatch(/retry/i);
    // The failure path uses Sonner's built-in error template — its only
    // action slot is the Retry button. No "Cancel" label appears here.
    expect(errorCall[1].action!.label).not.toMatch(/cancel/i);
  });

  it("(12.2.10) Cancel action survives across retrying→downloading transition (resume flow)", () => {
    toast.loading.mockReturnValueOnce("toast-A");
    createDownloadJobToaster({ toast, eventApi, syncApi });

    // downloading → retrying → downloading (resume after sleep)
    eventApi.emit(
      downloadingEvent("job-A", { progress: 20, path: "/welcome.pdf" }),
    );
    eventApi.emit({
      kind: "download-retrying",
      payload: {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        attempt: 1,
        limit: 5,
        waitMs: 1000,
        engineCause: "network-error",
      },
    });
    eventApi.emit(
      downloadingEvent("job-A", { progress: 21, path: "/welcome.pdf" }),
    );

    expect(toast.loading).toHaveBeenCalledTimes(3);
    for (const call of toast.loading.mock.calls) {
      const [, opts] = call as [
        string,
        { action?: { label: string; onClick: () => void } },
      ];
      expect(opts.action).toBeDefined();
      expect(opts.action!.label).toBe("Cancel");
    }
  });
});

// §12.3 — Decision 14 bytes-only progress fallback. When the engine
// payload's `bytesTotal` is null (provider didn't advertise
// Content-Length — Drive's `?alt=media` for some media files, chunked
// transfer encoding), the toast falls back to `<X> MB` (or `<X.XX> GB`
// at the 1 GB threshold). Otherwise it keeps the percentage format.
describe("createDownloadJobToaster — bytes-only progress fallback (§12.3)", () => {
  let toast: MockToast;
  let eventApi: MockEventApi;

  beforeEach(() => {
    toast = makeToast();
    eventApi = makeEventApi();
  });

  it("(12.3.10) toast shows bytes-only when bytesTotal is null", () => {
    createDownloadJobToaster({ toast, eventApi });
    eventApi.emit(
      downloadingEvent("job-A", {
        progress: 0,
        path: "/welcome.mp4",
        bytesLoaded: 5_242_880,
        bytesTotal: null,
      }),
    );
    expect(toast.loading).toHaveBeenCalledTimes(1);
    const [msg] = toast.loading.mock.calls[0] as [string, unknown];
    expect(msg).toBe("Downloading welcome.mp4 — 5.0 MB");
  });

  it("(12.3.11) toast shows percentage when bytesTotal is non-null", () => {
    createDownloadJobToaster({ toast, eventApi });
    eventApi.emit(
      downloadingEvent("job-A", {
        progress: 42,
        path: "/welcome.mp4",
        bytesLoaded: 167_772_160,
        bytesTotal: 398_458_880,
      }),
    );
    const [msg] = toast.loading.mock.calls[0] as [string, unknown];
    expect(msg).toBe("Downloading welcome.mp4 — 42%");
  });

  it("(12.3.12) toast scales to GB when bytesLoaded crosses 1 GB threshold (bytesTotal === null)", () => {
    createDownloadJobToaster({ toast, eventApi });
    eventApi.emit(
      downloadingEvent("job-A", {
        progress: 0,
        path: "/movie.mp4",
        bytesLoaded: 1_073_741_824, // 1 GB exactly
        bytesTotal: null,
      }),
    );
    const [msgAt1G] = toast.loading.mock.calls[0] as [string, unknown];
    expect(msgAt1G).toBe("Downloading movie.mp4 — 1.00 GB");

    eventApi.emit(
      downloadingEvent("job-A", {
        progress: 0,
        path: "/movie.mp4",
        bytesLoaded: 1_610_612_736, // 1.5 GB
        bytesTotal: null,
      }),
    );
    const [msgAt1_5G] = toast.loading.mock.calls[1] as [string, unknown];
    expect(msgAt1_5G).toBe("Downloading movie.mp4 — 1.50 GB");
  });

  it("(12.3.13) hydration with null contentLength uses bytes-only", () => {
    const toaster = createDownloadJobToaster({ toast, eventApi });
    toaster.hydrateActiveDownloads([
      {
        downloadJobId: "job-A",
        datasourceId: "ds-1",
        sourcePath: "/welcome.mp4",
        targetPath: "/Users/alice/Downloads/ft5/welcome.mp4",
        bytesDownloaded: 52_428_800, // 50 MB
        contentLength: null,
        startedAt: 0,
      },
    ]);
    expect(toast.loading).toHaveBeenCalledTimes(1);
    const [msg] = toast.loading.mock.calls[0] as [string, unknown];
    expect(msg).toBe("Downloading welcome.mp4 — 50.0 MB");
  });

  it("(12.3.14) progress updates tick up the bytes count when total is unknown", () => {
    createDownloadJobToaster({ toast, eventApi });
    // Same job, three successive events — the toast should update in
    // place with the rising bytes count.
    eventApi.emit(
      downloadingEvent("job-A", {
        progress: 0,
        path: "/welcome.mp4",
        bytesLoaded: 5_242_880,
        bytesTotal: null,
      }),
    );
    eventApi.emit(
      downloadingEvent("job-A", {
        progress: 0,
        path: "/welcome.mp4",
        bytesLoaded: 31_457_280,
        bytesTotal: null,
      }),
    );
    eventApi.emit(
      downloadingEvent("job-A", {
        progress: 0,
        path: "/welcome.mp4",
        bytesLoaded: 104_857_600,
        bytesTotal: null,
      }),
    );
    expect(toast.loading).toHaveBeenCalledTimes(3);
    const [msg1] = toast.loading.mock.calls[0] as [string, unknown];
    const [msg2] = toast.loading.mock.calls[1] as [string, unknown];
    const [msg3] = toast.loading.mock.calls[2] as [string, unknown];
    expect(msg1).toBe("Downloading welcome.mp4 — 5.0 MB");
    expect(msg2).toBe("Downloading welcome.mp4 — 30.0 MB");
    expect(msg3).toBe("Downloading welcome.mp4 — 100.0 MB");
  });
});
