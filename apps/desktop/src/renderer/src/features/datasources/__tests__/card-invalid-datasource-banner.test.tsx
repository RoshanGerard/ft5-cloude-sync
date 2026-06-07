/** @vitest-environment jsdom */
//
// implement-datasource-onboarding §26 — InvalidDatasourceBanner migration tests.
//
// Reconnect now calls window.api.sync.authenticateStart and useAuthSession
// drives the disabled / "Connecting…" state. Remove confirmation triggers
// `datasources.remove` (the desktop main handler internally calls
// `sync:delete-credentials` per §20 — that pairing is asserted at the
// main-process layer in remove.test.ts, not here).

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
let removeMock: Mock;
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
  removeMock = vi.fn().mockResolvedValue({ ok: true });
  listMock = vi.fn().mockResolvedValue({ datasources: [] });
  syncOnEventListeners = [];

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: listMock,
      add: vi.fn(),
      remove: removeMock,
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
    errorReason: "Credentials are missing — reconnect this datasource",
    errorKind: "invalid-datasource",
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

describe("InvalidDatasourceBanner — renders iff errorKind is invalid-datasource", () => {
  it("renders invalid-datasource-banner with both action buttons", () => {
    renderCard(buildErrorSummary({ errorKind: "invalid-datasource" }));
    const banner = screen.getByTestId("invalid-datasource-banner");
    expect(banner).toBeInTheDocument();
    expect(
      within(banner).getByRole("button", { name: /reconnect/i }),
    ).toBeInTheDocument();
    expect(
      within(banner).getByRole("button", { name: /^remove$/i }),
    ).toBeInTheDocument();
  });

  it("hides the bare error-reason paragraph when banner is shown", () => {
    renderCard(buildErrorSummary({ errorKind: "invalid-datasource" }));
    expect(screen.queryByTestId("error-reason-text")).not.toBeInTheDocument();
  });

  it("does NOT render <AuthErrorBanner> for invalid-datasource", () => {
    renderCard(buildErrorSummary({ errorKind: "invalid-datasource" }));
    expect(screen.queryByTestId("auth-error-banner")).not.toBeInTheDocument();
  });

  it("Reconnect click calls sync.authenticateStart with {providerId, datasourceId} exactly once", async () => {
    renderCard(
      buildErrorSummary({
        id: "ds-gd-err",
        providerId: "google-drive",
        errorKind: "invalid-datasource",
      }),
    );
    const banner = screen.getByTestId("invalid-datasource-banner");
    fireEvent.click(within(banner).getByRole("button", { name: /reconnect/i }));

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateStartMock.mock.calls[0]![0]).toEqual({
      providerId: "google-drive",
      datasourceId: "ds-gd-err",
    });
  });

  it("Remove click opens the confirm dialog without dispatching IPC; confirming dispatches remove({datasourceId}) exactly once", async () => {
    renderCard(
      buildErrorSummary({
        id: "ds-gd-err",
        errorKind: "invalid-datasource",
      }),
    );
    const banner = screen.getByTestId("invalid-datasource-banner");
    fireEvent.click(within(banner).getByRole("button", { name: /^remove$/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(removeMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(removeMock).toHaveBeenCalledTimes(1);
    });
    expect(removeMock.mock.calls[0]![0]).toEqual({ datasourceId: "ds-gd-err" });
  });

  it("banner unmounts when auth-completed flips the summary back to connected", async () => {
    const errSummary = buildErrorSummary({ errorKind: "invalid-datasource" });
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

    await screen.findByTestId("invalid-datasource-banner");

    const banner = screen.getByTestId("invalid-datasource-banner");
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
      expect(
        screen.queryByTestId("invalid-datasource-banner"),
      ).not.toBeInTheDocument();
    });
  });
});

describe("InvalidDatasourceBanner — does NOT render for other errorKinds", () => {
  it("network-error → bare <p data-testid='error-reason-text'>; no banners", () => {
    renderCard(
      buildErrorSummary({
        errorKind: "network-error" as never,
        errorReason: "Network unreachable",
      }),
    );
    expect(screen.getByTestId("error-reason-text")).toBeInTheDocument();
    expect(
      screen.queryByTestId("invalid-datasource-banner"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("auth-error-banner")).not.toBeInTheDocument();
  });

  it("auth-revoked → <AuthErrorBanner> renders; invalid-datasource banner absent", () => {
    renderCard(buildErrorSummary({ errorKind: "auth-revoked" }));
    expect(screen.getByTestId("auth-error-banner")).toBeInTheDocument();
    expect(
      screen.queryByTestId("invalid-datasource-banner"),
    ).not.toBeInTheDocument();
  });
});

describe("InvalidDatasourceBanner — structural a11y", () => {
  it("banner exposes a non-empty aria-label", () => {
    renderCard(buildErrorSummary({ errorKind: "invalid-datasource" }));
    const banner = screen.getByTestId("invalid-datasource-banner");
    const label = banner.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label!.trim().length).toBeGreaterThan(0);
  });

  it("both action buttons have non-empty accessible names", () => {
    renderCard(buildErrorSummary({ errorKind: "invalid-datasource" }));
    const banner = screen.getByTestId("invalid-datasource-banner");
    const reconnect = within(banner).getByRole("button", {
      name: /reconnect/i,
    });
    const remove = within(banner).getByRole("button", { name: /^remove$/i });
    expect(reconnect.textContent?.trim()).toBeTruthy();
    expect(remove.textContent?.trim()).toBeTruthy();
  });

  it("tab order inside the banner is Reconnect → Remove", () => {
    renderCard(buildErrorSummary({ errorKind: "invalid-datasource" }));
    const banner = screen.getByTestId("invalid-datasource-banner");
    const buttons = banner.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons[0]!.textContent?.toLowerCase()).toMatch(/reconnect/);
    expect(buttons[1]!.textContent?.toLowerCase()).toMatch(/^remove$/);
    expect(buttons[0]!.getAttribute("tabindex")).toBeNull();
    expect(buttons[1]!.getAttribute("tabindex")).toBeNull();
  });
});
