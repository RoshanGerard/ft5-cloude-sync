/** @vitest-environment jsdom */
//
// implement-datasource-onboarding §28 — auth-* event plumbing in store.tsx.
//
// Renamed from `store-consent.test.tsx`. Re-targets the assertions from the
// retired `consent-*` event family (datasources.onEvent channel) to the
// new `auth-*` family on the sync.onEvent channel per design Decision 7.
// The store reducer now translates each auth-* SyncEvent into an
// `auth/...` reducer action via the `useAuthSession(correlationId)` hook.
//
// This is a slimmer dual of `use-auth-session.test.tsx` — that file
// validates the hook surface; this file validates the store-level
// integration: provider mounts → subscribes once via window.api.sync.onEvent
// → dispatches per kind.

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

let syncOnEventCapture: ((event: SyncEvent) => void) | null = null;
let syncOnEventMock: Mock;
let listMock: Mock;

const FIXTURE_SUMMARY = {
  id: "ds-X",
  providerId: "google-drive" as const,
  displayName: "Drive",
  status: "connected" as const,
  errorReason: null,
  errorKind: null,
  paused: false,
  lastSyncAt: null,
  itemCount: 0,
};

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

describe("store auth-* slice — sync.onEvent integration", () => {
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
        <AuthProbe correlationId="corr-1" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    expect(screen.getByTestId("status").textContent).toBe("pending");
  });

  it("transitions to status='completed' and surfaces datasourceId on auth-completed", async () => {
    render(
      <DatasourcesProvider>
        <AuthProbe correlationId="corr-1" />
      </DatasourcesProvider>,
    );
    await act(async () => {});

    act(() => {
      syncOnEventCapture!({
        kind: "auth-completed",
        payload: {
          correlationId: "corr-1",
          datasourceId: "ds-google-drive-abc123",
          summary: FIXTURE_SUMMARY,
        },
      });
    });

    expect(screen.getByTestId("status").textContent).toBe("completed");
    expect(screen.getByTestId("datasource-id").textContent).toBe(
      "ds-google-drive-abc123",
    );
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

  it("events for a different correlationId do not affect the probe's state", async () => {
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
});
