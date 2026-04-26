/** @vitest-environment jsdom */
//
// implement-datasource-onboarding §22 — OAuthForm migration tests.
//
// The form now drives the service-side authenticate flow:
//   - Connect → window.api.sync.authenticateStart({providerId, datasourceId?})
//   - response carries {correlationId, kind: "oauth"}
//   - useAuthSession(correlationId) drives status transitions via auth-* events
//   - terminal "completed" → onSubmit({_authCompleted: "completed", datasourceId})
//   - terminal cancelled / failed / timeout → inline copy + Retry button
//   - service-config-missing arrives via auth-failed AND via the start-call's
//     `{ ok: false, error: { tag: "service-config-missing", path } }` envelope
//   - Dialog unmount → window.api.sync.authenticateCancel({correlationId})
//
// Replaces the legacy datasources.startConsent / cancelConsent / consent-*
// surface entirely.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { SyncEvent } from "@ft5/ipc-contracts/sync-service-desktop";

import { DatasourcesProvider } from "../store";
import { OAuthForm, type OAuthFormProps } from "../credential-forms/oauth-form";

// ---------------------------------------------------------------------------
// Shared API mock harness
// ---------------------------------------------------------------------------

let authenticateStartMock: Mock;
let authenticateCancelMock: Mock;
let authenticateCompleteMock: Mock;
let addMock: Mock;
let syncOnEventCapture: ((event: SyncEvent) => void) | null = null;

const FIXTURE_SUMMARY = {
  id: "ds-google-drive-new",
  providerId: "google-drive" as const,
  displayName: "My Drive",
  status: "connected" as const,
  errorReason: null,
  errorKind: null,
  paused: false,
  lastSyncAt: null,
  itemCount: 0,
};

function installApiMock() {
  authenticateStartMock = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      result: { correlationId: "corr-test", kind: "oauth" },
    });
  authenticateCancelMock = vi
    .fn()
    .mockResolvedValue({ ok: true, result: { cancelled: true } });
  authenticateCompleteMock = vi.fn();
  addMock = vi.fn();
  const syncOnEventMock = vi
    .fn()
    .mockImplementation((cb: (e: SyncEvent) => void) => {
      syncOnEventCapture = cb;
      return () => {
        syncOnEventCapture = null;
      };
    });

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: addMock,
      remove: vi.fn(),
      action: vi.fn(),
      pickFilesToUpload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    sync: {
      listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      onEvent: syncOnEventMock,
      authenticateStart: authenticateStartMock,
      authenticateComplete: authenticateCompleteMock,
      authenticateCancel: authenticateCancelMock,
    },
  };
}

function renderForm(props: Partial<OAuthFormProps> = {}) {
  const defaults: OAuthFormProps = {
    providerId: "google-drive",
    providerDisplayName: "Google Drive",
    onSubmit: vi.fn(),
    onBack: vi.fn(),
  };
  return render(
    <DatasourcesProvider>
      <OAuthForm {...defaults} {...props} />
    </DatasourcesProvider>,
  );
}

beforeEach(() => {
  syncOnEventCapture = null;
  installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Connect → sync.authenticateStart
// ---------------------------------------------------------------------------

describe("OAuthForm — calls sync.authenticateStart on Connect", () => {
  it("does not call any API on mount", async () => {
    renderForm();
    await act(async () => {});

    expect(authenticateStartMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("calls sync.authenticateStart({providerId}) when Connect is clicked", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateStartMock.mock.calls[0]![0]).toEqual({
      providerId: "google-drive",
    });
  });

  it("does NOT call datasources.add when Connect is clicked", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    expect(addMock).not.toHaveBeenCalled();
  });

  it("passes datasourceId in the start request when provided (reconnect path)", async () => {
    renderForm({ datasourceId: "ds-existing-123" });
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateStartMock.mock.calls[0]![0]).toEqual({
      providerId: "google-drive",
      datasourceId: "ds-existing-123",
    });
  });
});

// ---------------------------------------------------------------------------
// auth-completed → onSubmit with sentinel + datasourceId
// ---------------------------------------------------------------------------

describe("OAuthForm — transitions to done on auth-completed", () => {
  it("calls onSubmit with {_authCompleted, datasourceId} when auth-completed arrives for the matching correlationId", async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });

    act(() => {
      syncOnEventCapture!({
        kind: "auth-completed",
        payload: {
          correlationId: "corr-test",
          datasourceId: "ds-google-drive-new",
          summary: FIXTURE_SUMMARY,
        },
      });
    });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith({
      _authCompleted: "completed",
      datasourceId: "ds-google-drive-new",
    });
  });

  it("does not call onSubmit when auth-completed arrives for a different correlationId", async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });

    act(() => {
      syncOnEventCapture!({
        kind: "auth-completed",
        payload: {
          correlationId: "corr-other",
          datasourceId: "ds-other",
          summary: FIXTURE_SUMMARY,
        },
      });
    });

    await act(async () => {});
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// auth-cancelled / auth-failed / auth-timeout → inline copy + Retry
// ---------------------------------------------------------------------------

describe("OAuthForm — surfaces cancel and timeout inline with Retry", () => {
  it("shows cancellation copy and Retry button after auth-cancelled", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );

    act(() => {
      syncOnEventCapture!({
        kind: "auth-cancelled",
        payload: { correlationId: "corr-test" },
      });
    });

    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status.textContent).toMatch(/cancel/i);
    });
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows timeout copy and Retry button after auth-timeout", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );

    act(() => {
      syncOnEventCapture!({
        kind: "auth-timeout",
        payload: { correlationId: "corr-test" },
      });
    });

    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status.textContent).toMatch(/timed out/i);
    });
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows failed copy with the auth-failed message and Retry button", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );

    act(() => {
      syncOnEventCapture!({
        kind: "auth-failed",
        payload: {
          correlationId: "corr-test",
          tag: "auth-revoked",
          message: "Token was revoked by the user",
        },
      });
    });

    await waitFor(() => {
      const failed = screen.getByTestId("oauth-failed");
      expect(failed.textContent).toMatch(/revoked/i);
    });
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("clicking Retry resets the session and calls authenticateStart again", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );

    act(() => {
      syncOnEventCapture!({
        kind: "auth-cancelled",
        payload: { correlationId: "corr-test" },
      });
    });

    const retryBtn = await screen.findByRole("button", { name: /retry/i });
    authenticateStartMock.mockResolvedValue({
      ok: true,
      result: { correlationId: "corr-retry", kind: "oauth" },
    });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(2);
    });
  });
});

// ---------------------------------------------------------------------------
// service-config-missing surfacing — both via response error AND via auth-failed
// ---------------------------------------------------------------------------

describe("OAuthForm — service-config-missing inline copy", () => {
  it("renders the inline service-config-missing copy with the path as inline code (response.ok === false)", async () => {
    authenticateStartMock.mockResolvedValueOnce({
      ok: false,
      error: {
        tag: "service-config-missing",
        path: "/home/user/ft5/sync_app/config.json",
        providerId: "google-drive",
      },
    });

    renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );

    const failed = await screen.findByTestId("oauth-failed");
    expect(failed.textContent).toMatch(
      /service configuration missing/i,
    );
    // Path is rendered as <code>
    expect(failed.querySelector("code")?.textContent).toBe(
      "/home/user/ft5/sync_app/config.json",
    );
    expect(failed.textContent).toMatch(/README/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Unmount → sync.authenticateCancel
// ---------------------------------------------------------------------------

describe("OAuthForm — unmount cancels active session", () => {
  it("calls sync.authenticateCancel({correlationId}) when the form unmounts after Connect", async () => {
    const { unmount } = renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );

    unmount();

    await waitFor(() => {
      expect(authenticateCancelMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateCancelMock.mock.calls[0]![0]).toEqual({
      correlationId: "corr-test",
    });
  });

  it("does NOT call authenticateCancel when the form unmounts before Connect was clicked", async () => {
    const { unmount } = renderForm();
    await act(async () => {});

    unmount();

    await act(async () => {});
    expect(authenticateCancelMock).not.toHaveBeenCalled();
  });

  it("calls authenticateCancel on unmount even after a terminal state — service cancel is idempotent", async () => {
    const { unmount } = renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );

    act(() => {
      syncOnEventCapture!({
        kind: "auth-cancelled",
        payload: { correlationId: "corr-test" },
      });
    });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/cancel/i);
    });

    unmount();

    await waitFor(() => {
      expect(authenticateCancelMock).toHaveBeenCalledTimes(1);
    });
  });
});
