/** @vitest-environment jsdom */
//
// Task 7.1 — useConsentSession hook + consent event plumbing in store.tsx.
//
// The DatasourcesProvider subscribes to window.api.datasources.onEvent and
// forwards ConsentEvent variants to per-session subscribers. The
// useConsentSession(sessionId) hook reads from that store slice and returns
// the current session state.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ConsentEvent } from "@ft5/ipc-contracts";

import { DatasourcesProvider, useConsentSession } from "../store";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let onEventCapture: ((event: ConsentEvent) => void) | null = null;
let onEventMock: Mock;
let listMock: Mock;

function installApiMock() {
  onEventMock = vi.fn().mockImplementation((cb: (e: ConsentEvent) => void) => {
    onEventCapture = cb;
    return () => {
      onEventCapture = null;
    };
  });
  listMock = vi
    .fn()
    .mockResolvedValue({ datasources: [] });

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: listMock,
      add: vi.fn(),
      remove: vi.fn(),
      action: vi.fn(),
      startConsent: vi.fn(),
      cancelConsent: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: onEventMock,
    },
    sync: {
      listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
  };
}

// A tiny probe component that reads the hook and renders the status string.
function ConsentProbe({ sessionId }: { sessionId: string }) {
  const state = useConsentSession(sessionId);
  return (
    <div data-testid="consent-state">
      <span data-testid="status">{state.status}</span>
      {"datasourceId" in state && (
        <span data-testid="datasource-id">{state.datasourceId}</span>
      )}
      {"tag" in state && <span data-testid="tag">{state.tag}</span>}
      {"message" in state && state.message !== undefined && (
        <span data-testid="message">{state.message}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useConsentSession — consent event plumbing", () => {
  beforeEach(() => {
    onEventCapture = null;
    installApiMock();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("returns status='pending' when the session has not yet received a terminal event", async () => {
    render(
      <DatasourcesProvider>
        <ConsentProbe sessionId="sess-1" />
      </DatasourcesProvider>,
    );

    // Allow effects to settle (list(), sync subscription).
    await act(async () => {});

    expect(screen.getByTestId("status").textContent).toBe("pending");
  });

  it("transitions to status='completed' and surfaces datasourceId on consent-completed", async () => {
    render(
      <DatasourcesProvider>
        <ConsentProbe sessionId="sess-1" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    const completedEvent: ConsentEvent = {
      event: "consent-completed",
      sessionId: "sess-1",
      datasourceId: "ds-google-drive-abc123",
    };
    act(() => {
      onEventCapture!(completedEvent);
    });

    expect(screen.getByTestId("status").textContent).toBe("completed");
    expect(screen.getByTestId("datasource-id").textContent).toBe(
      "ds-google-drive-abc123",
    );
  });

  it("transitions to status='cancelled' on consent-cancelled", async () => {
    render(
      <DatasourcesProvider>
        <ConsentProbe sessionId="sess-2" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    act(() => {
      onEventCapture!({
        event: "consent-cancelled",
        sessionId: "sess-2",
      });
    });

    expect(screen.getByTestId("status").textContent).toBe("cancelled");
  });

  it("transitions to status='failed' and surfaces tag + message on consent-failed", async () => {
    render(
      <DatasourcesProvider>
        <ConsentProbe sessionId="sess-3" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    act(() => {
      onEventCapture!({
        event: "consent-failed",
        sessionId: "sess-3",
        tag: "auth-revoked",
        message: "Token was revoked by the user",
      });
    });

    expect(screen.getByTestId("status").textContent).toBe("failed");
    expect(screen.getByTestId("tag").textContent).toBe("auth-revoked");
    expect(screen.getByTestId("message").textContent).toBe(
      "Token was revoked by the user",
    );
  });

  it("transitions to status='timeout' on consent-timeout", async () => {
    render(
      <DatasourcesProvider>
        <ConsentProbe sessionId="sess-4" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    act(() => {
      onEventCapture!({
        event: "consent-timeout",
        sessionId: "sess-4",
      });
    });

    expect(screen.getByTestId("status").textContent).toBe("timeout");
  });

  it("events for a different sessionId do not affect the probe's state", async () => {
    render(
      <DatasourcesProvider>
        <ConsentProbe sessionId="sess-mine" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    act(() => {
      onEventCapture!({
        event: "consent-completed",
        sessionId: "sess-other",
        datasourceId: "ds-other",
      });
    });

    // Still pending — the event was for a different session.
    expect(screen.getByTestId("status").textContent).toBe("pending");
  });
});
