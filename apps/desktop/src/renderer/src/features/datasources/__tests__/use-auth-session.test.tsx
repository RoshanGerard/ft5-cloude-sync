/** @vitest-environment jsdom */
//
// implement-datasource-onboarding §21 — useAuthSession hook + auth-* event
// plumbing in store.tsx.
//
// The DatasourcesProvider subscribes to window.api.sync.onEvent and forwards
// auth-* event variants to per-correlation subscribers. The
// useAuthSession(correlationId) hook reads from that store slice and returns
// the current authenticate session state.

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
import type { SyncEvent } from "@ft5/ipc-contracts/sync-service-desktop";

import { DatasourcesProvider, useAuthSession } from "../store";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let syncOnEventCapture: ((event: SyncEvent) => void) | null = null;
let syncOnEventMock: Mock;
let listMock: Mock;

function installApiMock() {
  syncOnEventMock = vi
    .fn()
    .mockImplementation((cb: (e: SyncEvent) => void) => {
      syncOnEventCapture = cb;
      return () => {
        syncOnEventCapture = null;
      };
    });
  listMock = vi.fn().mockResolvedValue({ datasources: [] });

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: listMock,
      add: vi.fn(),
      remove: vi.fn(),
      action: vi.fn(),
      pickFilesToUpload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    sync: {
      listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      onEvent: syncOnEventMock,
      authenticateStart: vi.fn(),
      authenticateComplete: vi.fn(),
      authenticateCancel: vi.fn(),
    },
  };
}

const FIXTURE_SUMMARY = {
  id: "ds-X",
  providerId: "google-drive" as const,
  displayName: "My Drive",
  status: "connected" as const,
  errorReason: null,
  errorKind: null,
  paused: false,
  lastSyncAt: null,
  itemCount: 0,
};

function AuthProbe({ correlationId }: { correlationId: string }) {
  const state = useAuthSession(correlationId);
  return (
    <div data-testid="auth-state">
      <span data-testid="status">{state.status}</span>
      {"datasourceId" in state && state.datasourceId !== undefined && (
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

describe("useAuthSession — auth-* event plumbing", () => {
  beforeEach(() => {
    syncOnEventCapture = null;
    installApiMock();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("returns status='pending' when the session has not yet received a terminal event", async () => {
    render(
      <DatasourcesProvider>
        <AuthProbe correlationId="corr-123" />
      </DatasourcesProvider>,
    );

    await act(async () => {});

    expect(screen.getByTestId("status").textContent).toBe("pending");
  });

  it("transitions to status='completed' and surfaces datasourceId on auth-completed", async () => {
    render(
      <DatasourcesProvider>
        <AuthProbe correlationId="corr-123" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    act(() => {
      syncOnEventCapture!({
        kind: "auth-completed",
        payload: {
          correlationId: "corr-123",
          datasourceId: "ds-X",
          summary: FIXTURE_SUMMARY,
        },
      });
    });

    expect(screen.getByTestId("status").textContent).toBe("completed");
    expect(screen.getByTestId("datasource-id").textContent).toBe("ds-X");
  });

  it("transitions to status='cancelled' on auth-cancelled", async () => {
    render(
      <DatasourcesProvider>
        <AuthProbe correlationId="corr-2" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    act(() => {
      syncOnEventCapture!({
        kind: "auth-cancelled",
        payload: { correlationId: "corr-2" },
      });
    });

    expect(screen.getByTestId("status").textContent).toBe("cancelled");
  });

  it("transitions to status='failed' and surfaces tag + message on auth-failed", async () => {
    render(
      <DatasourcesProvider>
        <AuthProbe correlationId="corr-3" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    act(() => {
      syncOnEventCapture!({
        kind: "auth-failed",
        payload: {
          correlationId: "corr-3",
          tag: "auth-revoked",
          message: "Token was revoked by the user",
        },
      });
    });

    expect(screen.getByTestId("status").textContent).toBe("failed");
    expect(screen.getByTestId("tag").textContent).toBe("auth-revoked");
    expect(screen.getByTestId("message").textContent).toBe(
      "Token was revoked by the user",
    );
  });

  it("transitions to status='timeout' on auth-timeout", async () => {
    render(
      <DatasourcesProvider>
        <AuthProbe correlationId="corr-4" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    act(() => {
      syncOnEventCapture!({
        kind: "auth-timeout",
        payload: { correlationId: "corr-4" },
      });
    });

    expect(screen.getByTestId("status").textContent).toBe("timeout");
  });

  it("ignores events for other correlationIds (no state transition)", async () => {
    render(
      <DatasourcesProvider>
        <AuthProbe correlationId="corr-mine" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

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

    expect(screen.getByTestId("status").textContent).toBe("pending");
  });

  it("ignores non-auth sync events (job-* events do not affect auth state)", async () => {
    render(
      <DatasourcesProvider>
        <AuthProbe correlationId="corr-5" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    act(() => {
      // job-completed is not an auth event — should not affect auth state.
      syncOnEventCapture!({
        kind: "job-completed",
        payload: {
          jobId: "j-1",
          completedAt: 0,
        },
      });
    });

    expect(screen.getByTestId("status").textContent).toBe("pending");
  });

  it("auth-failed with service-config-missing tag surfaces tag + message", async () => {
    render(
      <DatasourcesProvider>
        <AuthProbe correlationId="corr-cfg" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    // Note: service-config-missing arrives via the request/response path, not
    // events. But the AuthFailedTag union is narrow per design Decision 7;
    // engine-error / auth-revoked / provider-error are the actual event tags.
    // Still — the hook is tag-agnostic; assert it surfaces whatever tag arrives.
    act(() => {
      syncOnEventCapture!({
        kind: "auth-failed",
        payload: {
          correlationId: "corr-cfg",
          tag: "engine-error",
          message:
            "Service configuration missing. Add OAuth credentials to /home/u/ft5/sync_app/config.json",
        },
      });
    });

    expect(screen.getByTestId("status").textContent).toBe("failed");
    expect(screen.getByTestId("tag").textContent).toBe("engine-error");
    expect(screen.getByTestId("message").textContent).toContain(
      "config.json",
    );
  });
});
