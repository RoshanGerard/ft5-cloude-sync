/** @vitest-environment jsdom */
//
// implement-datasource-onboarding §25 — AuthErrorBanner migration tests.
//
// Reconnect now calls window.api.sync.authenticateStart({providerId,
// datasourceId}) and the useAuthSession(correlationId) hook drives the
// disabled / "Connecting…" state. auth-completed event arrival flips the
// card's status back to connected via the existing event stream.

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
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DatasourceSummary } from "@ft5/ipc-contracts";
import type { SyncEvent } from "@ft5/ipc-contracts/sync-service-desktop";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

import { DatasourceCard } from "../card";
import { DatasourcesProvider } from "../store";
import { DatasourcesDashboard } from "../dashboard";

let authenticateStartMock: Mock;
let listMock: Mock;
// Capture ALL registered window.api.sync.onEvent listeners. The store
// subscribes one, and each card's upload-job toaster subscribes another
// (migrate-upload §13.4 rewired the toaster onto sync.onEvent). Emitting to
// every listener mirrors the real broadcast bridge — capturing only the last
// one would land on the toaster's upload-only filter and drop auth events.
let syncOnEventListeners: Array<(event: SyncEvent) => void> = [];
function emitSyncEvent(event: SyncEvent): void {
  for (const cb of [...syncOnEventListeners]) cb(event);
}

function installApiMock() {
  authenticateStartMock = vi.fn().mockResolvedValue({
    ok: true,
    result: { correlationId: "corr-reconnect", kind: "oauth" },
  });
  listMock = vi.fn().mockResolvedValue({ datasources: [] });
  syncOnEventListeners = [];

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: listMock,
      add: vi.fn(),
      remove: vi.fn().mockResolvedValue({ ok: true }),
      action: vi.fn(),
      pickFilesToUpload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    sync: {
      listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      onEvent: vi.fn().mockImplementation((cb: (e: SyncEvent) => void) => {
        syncOnEventListeners.push(cb);
        return () => {
          syncOnEventListeners = syncOnEventListeners.filter((l) => l !== cb);
        };
      }),
      authenticateStart: authenticateStartMock,
      authenticateComplete: vi.fn(),
      authenticateCancel: vi
        .fn()
        .mockResolvedValue({ ok: true, result: { cancelled: true } }),
    },
  };
}

function buildErrorSummary(
  overrides: Partial<DatasourceSummary> = {},
): DatasourceSummary {
  return {
    id: "ds-gd-err",
    displayName: "Personal Drive",
    providerId: "google-drive",
    status: "error",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 100,
    errorReason: "Refresh token expired — reconnect required",
    errorKind: "auth-revoked",
    paused: false,
    ...overrides,
  } as DatasourceSummary;
}

function renderCard(summary: DatasourceSummary): ReturnType<typeof render> {
  return render(
    <DatasourcesProvider>
      <DatasourceCard summary={summary} />
    </DatasourcesProvider>,
  );
}

beforeEach(() => {
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
  installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuthErrorBanner — renders iff errorKind is auth-class", () => {
  it("renders auth-error-banner for errorKind='auth-revoked'", () => {
    renderCard(buildErrorSummary({ errorKind: "auth-revoked" }));
    expect(screen.getByTestId("auth-error-banner")).toBeInTheDocument();
  });

  it("renders auth-error-banner for errorKind='auth-expired'", () => {
    renderCard(buildErrorSummary({ errorKind: "auth-expired" }));
    expect(screen.getByTestId("auth-error-banner")).toBeInTheDocument();
  });

  it("banner contains an accessible Reconnect button", () => {
    renderCard(buildErrorSummary({ errorKind: "auth-revoked" }));
    const banner = screen.getByTestId("auth-error-banner");
    expect(
      within(banner).getByRole("button", { name: /reconnect/i }),
    ).toBeInTheDocument();
  });

  it("bare <p className='text-destructive text-xs'> is NOT present when banner is shown", () => {
    renderCard(buildErrorSummary({ errorKind: "auth-revoked" }));
    expect(screen.queryByTestId("error-reason-text")).not.toBeInTheDocument();
  });
});

describe("AuthErrorBanner — non-auth errors use bare paragraph", () => {
  it("does NOT render auth-error-banner for errorKind='network-error'", () => {
    renderCard(
      buildErrorSummary({
        errorKind: "network-error" as never,
        errorReason: "Network unreachable",
      }),
    );
    expect(screen.queryByTestId("auth-error-banner")).not.toBeInTheDocument();
  });

  it("shows bare error-reason paragraph for non-auth error", () => {
    renderCard(
      buildErrorSummary({
        errorKind: "network-error" as never,
        errorReason: "Network unreachable",
      }),
    );
    expect(screen.getByTestId("error-reason-text")).toBeInTheDocument();
    expect(screen.getByTestId("error-reason-text").textContent).toContain(
      "Network unreachable",
    );
  });

  it("does NOT render auth-error-banner when errorKind is null (non-error status)", () => {
    renderCard(
      buildErrorSummary({
        status: "connected",
        errorKind: null,
        errorReason: undefined,
      }),
    );
    expect(screen.queryByTestId("auth-error-banner")).not.toBeInTheDocument();
  });
});

describe("AuthErrorBanner — Reconnect calls sync.authenticateStart", () => {
  it("calls sync.authenticateStart with {providerId, datasourceId} when Reconnect is clicked", async () => {
    const summary = buildErrorSummary({
      id: "ds-gd-err",
      providerId: "google-drive",
      errorKind: "auth-revoked",
    });
    renderCard(summary);

    const banner = screen.getByTestId("auth-error-banner");
    const reconnectBtn = within(banner).getByRole("button", {
      name: /reconnect/i,
    });
    fireEvent.click(reconnectBtn);

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateStartMock.mock.calls[0]![0]).toEqual({
      providerId: "google-drive",
      datasourceId: "ds-gd-err",
    });
  });

  it("Reconnect button shows 'Connecting…' label and is disabled while pending", async () => {
    const summary = buildErrorSummary({ errorKind: "auth-revoked" });
    renderCard(summary);

    const banner = screen.getByTestId("auth-error-banner");
    fireEvent.click(within(banner).getByRole("button", { name: /reconnect/i }));

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });

    const button = await within(banner).findByRole("button", {
      name: /connecting/i,
    });
    expect(button).toBeDisabled();
  });

  it("card returns to 'connected' after auth-completed triggers a refresh", async () => {
    const errSummary = buildErrorSummary({ errorKind: "auth-revoked" });
    const connectedSummary: DatasourceSummary = {
      ...errSummary,
      status: "connected",
      errorKind: null,
      errorReason: undefined,
    } as DatasourceSummary;

    listMock
      .mockResolvedValueOnce({ datasources: [errSummary] })
      .mockResolvedValue({ datasources: [connectedSummary] });

    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );

    await screen.findByTestId("auth-error-banner");

    const banner = screen.getByTestId("auth-error-banner");
    fireEvent.click(within(banner).getByRole("button", { name: /reconnect/i }));
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );

    act(() => {
      emitSyncEvent({
        kind: "auth-completed",
        payload: {
          correlationId: "corr-reconnect",
          datasourceId: errSummary.id,
          summary: connectedSummary,
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("auth-error-banner")).not.toBeInTheDocument();
    });
  });
});

describe("AuthErrorBanner — accessible name and Tab order", () => {
  it("banner has aria-label or aria-labelledby", () => {
    renderCard(buildErrorSummary({ errorKind: "auth-revoked" }));
    const banner = screen.getByTestId("auth-error-banner");
    const hasAccessibleName =
      banner.hasAttribute("aria-label") ||
      banner.hasAttribute("aria-labelledby");
    expect(hasAccessibleName).toBe(true);
  });

  it("Reconnect button has a non-empty accessible name", () => {
    renderCard(buildErrorSummary({ errorKind: "auth-revoked" }));
    const banner = screen.getByTestId("auth-error-banner");
    const reconnect = within(banner).getByRole("button", { name: /reconnect/i });
    expect(reconnect.textContent?.trim()).toBeTruthy();
  });
});
