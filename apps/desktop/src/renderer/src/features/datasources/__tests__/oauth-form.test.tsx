/** @vitest-environment jsdom */
//
// Tasks 8.1–8.3 + 8.4 — OAuth form rewrite tests.
//
// 8.1: OAuthForm calls startConsent (not add) when Connect is clicked.
// 8.2: Form transitions to done / calls onSubmit on consent-completed.
// 8.3: Form surfaces cancel and timeout inline with a Retry button.
// 8.4: Non-OAuth forms (AwsAccessKeyForm) still go through actions.add.

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
import type { ConsentEvent } from "@ft5/ipc-contracts";

import { DatasourcesProvider } from "../store";
import { OAuthForm, type OAuthFormProps } from "../credential-forms/oauth-form";

// ---------------------------------------------------------------------------
// Shared API mock harness
// ---------------------------------------------------------------------------

let startConsentMock: Mock;
let cancelConsentMock: Mock;
let addMock: Mock;
let onEventCapture: ((event: ConsentEvent) => void) | null = null;

function installApiMock() {
  startConsentMock = vi
    .fn()
    .mockResolvedValue({ sessionId: "sess-test" });
  cancelConsentMock = vi.fn().mockResolvedValue(undefined);
  addMock = vi.fn();
  const onEventMock = vi
    .fn()
    .mockImplementation((cb: (e: ConsentEvent) => void) => {
      onEventCapture = cb;
      return () => {
        onEventCapture = null;
      };
    });

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: addMock,
      remove: vi.fn(),
      action: vi.fn(),
      upload: vi.fn(),
      startConsent: startConsentMock,
      cancelConsent: cancelConsentMock,
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: onEventMock,
    },
    sync: {
      listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      onEvent: vi.fn().mockReturnValue(() => {}),
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
  onEventCapture = null;
  installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 8.1 — startConsent, not add
// ---------------------------------------------------------------------------

describe("OAuthForm — 8.1: calls startConsent on connect", () => {
  it("calls window.api.datasources.startConsent with {providerId} when Connect is clicked", async () => {
    renderForm();
    await act(async () => {});

    const connectBtn = screen.getByRole("button", { name: /^connect/i });
    fireEvent.click(connectBtn);

    await waitFor(() => {
      expect(startConsentMock).toHaveBeenCalledTimes(1);
    });
    expect(startConsentMock.mock.calls[0]![0]).toEqual({
      providerId: "google-drive",
    });
  });

  it("does NOT call add() when Connect is clicked", async () => {
    renderForm();
    await act(async () => {});

    const connectBtn = screen.getByRole("button", { name: /^connect/i });
    fireEvent.click(connectBtn);

    await waitFor(() => {
      expect(startConsentMock).toHaveBeenCalledTimes(1);
    });
    expect(addMock).not.toHaveBeenCalled();
  });

  it("passes datasourceId in startConsent request when provided (reconnect path)", async () => {
    renderForm({ datasourceId: "ds-existing-123" });
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(startConsentMock).toHaveBeenCalledTimes(1);
    });
    expect(startConsentMock.mock.calls[0]![0]).toEqual({
      providerId: "google-drive",
      datasourceId: "ds-existing-123",
    });
  });
});

// ---------------------------------------------------------------------------
// 8.2 — done on consent-completed
// ---------------------------------------------------------------------------

describe("OAuthForm — 8.2: transitions to done on consent-completed", () => {
  it("calls onSubmit when consent-completed arrives for the session", async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(startConsentMock).toHaveBeenCalledTimes(1);
    });

    act(() => {
      onEventCapture!({
        event: "consent-completed",
        sessionId: "sess-test",
        datasourceId: "ds-google-drive-new",
      });
    });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  });

  it("does not call onSubmit when consent-completed arrives for a different session", async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(startConsentMock).toHaveBeenCalledTimes(1);
    });

    act(() => {
      onEventCapture!({
        event: "consent-completed",
        sessionId: "sess-other",
        datasourceId: "ds-other",
      });
    });

    // Give React a tick to process any state updates.
    await act(async () => {});
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8.3 — inline cancel / timeout with Retry
// ---------------------------------------------------------------------------

describe("OAuthForm — 8.3: surfaces cancel and timeout inline with Retry", () => {
  it("shows cancellation copy and Retry button after consent-cancelled", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() => expect(startConsentMock).toHaveBeenCalledTimes(1));

    act(() => {
      onEventCapture!({
        event: "consent-cancelled",
        sessionId: "sess-test",
      });
    });

    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status.textContent).toMatch(/cancel/i);
    });
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows timeout copy and Retry button after consent-timeout", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() => expect(startConsentMock).toHaveBeenCalledTimes(1));

    act(() => {
      onEventCapture!({
        event: "consent-timeout",
        sessionId: "sess-test",
      });
    });

    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status.textContent).toMatch(/timed out/i);
    });
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("clicking Retry resets the session and calls startConsent again", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() => expect(startConsentMock).toHaveBeenCalledTimes(1));

    act(() => {
      onEventCapture!({ event: "consent-cancelled", sessionId: "sess-test" });
    });

    const retryBtn = await screen.findByRole("button", { name: /retry/i });
    // Reset sessionId for the retry so the new startConsent returns a new sessionId.
    startConsentMock.mockResolvedValue({ sessionId: "sess-retry" });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(startConsentMock).toHaveBeenCalledTimes(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Unmount cleanup — D7 invariant: closing the dialog mid-OAuth must terminate
// the broker session so completeWith / addToRegistry never run for an
// abandoned flow. Without this, the broker keeps its loopback HTTP server
// bound; if the user already clicked Continue in the browser before closing
// the dialog, the callback still arrives and a registry row materialises in
// the dashboard for a session the user thought they cancelled.
// ---------------------------------------------------------------------------

describe("OAuthForm — unmount cancels active session", () => {
  it("calls cancelConsent({sessionId}) when the form unmounts after Connect", async () => {
    const { unmount } = renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() => expect(startConsentMock).toHaveBeenCalledTimes(1));

    // Simulate dialog close: unmount the form. The broker session must be
    // cancelled so the loopback server tears down.
    unmount();

    await waitFor(() => {
      expect(cancelConsentMock).toHaveBeenCalledTimes(1);
    });
    expect(cancelConsentMock.mock.calls[0]![0]).toEqual({ sessionId: "sess-test" });
  });

  it("does NOT call cancelConsent when the form unmounts before Connect was clicked", async () => {
    const { unmount } = renderForm();
    await act(async () => {});

    // No Connect click, no session — unmount immediately.
    unmount();

    await act(async () => {});
    expect(cancelConsentMock).not.toHaveBeenCalled();
  });

  it("calls cancelConsent on unmount even after a terminal state — broker is idempotent", async () => {
    const { unmount } = renderForm();
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));
    await waitFor(() => expect(startConsentMock).toHaveBeenCalledTimes(1));

    // Drive the session to a terminal "cancelled" state via the event stream.
    act(() => {
      onEventCapture!({ event: "consent-cancelled", sessionId: "sess-test" });
    });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/cancel/i);
    });

    // Now unmount. cancelConsent fires anyway — broker.cancel() is idempotent
    // on already-cleared sessions, so this is safe.
    unmount();

    await waitFor(() => {
      expect(cancelConsentMock).toHaveBeenCalledTimes(1);
    });
  });
});
