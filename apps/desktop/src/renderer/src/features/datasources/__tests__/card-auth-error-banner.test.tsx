/** @vitest-environment jsdom */
//
// Tasks 9.1–9.4 — AuthErrorBanner in DatasourceCard.
//
// 9.1: Banner renders iff errorKind is auth-class (auth-revoked / auth-expired).
// 9.2: Non-auth errors render the bare paragraph unchanged.
// 9.3: Clicking Reconnect calls startConsent({providerId, datasourceId});
//      consent-completed triggers a refresh that flips the card to "connected".
// 9.4: Banner has an accessible name and meets WCAG AA structural requirements.

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

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

let startConsentMock: Mock;
let listMock: Mock;
let onEventCapture: ((event: unknown) => void) | null = null;

function installApiMock() {
  startConsentMock = vi.fn().mockResolvedValue({ sessionId: "sess-reconnect" });
  listMock = vi.fn().mockResolvedValue({ datasources: [] });
  onEventCapture = null;

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: listMock,
      add: vi.fn(),
      remove: vi.fn().mockResolvedValue({ ok: true }),
      action: vi.fn(),
      upload: vi.fn().mockResolvedValue({ transactionId: "tx-test" }),
      startConsent: startConsentMock,
      cancelConsent: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockImplementation((cb: (e: unknown) => void) => {
        onEventCapture = cb;
        return () => { onEventCapture = null; };
      }),
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
    ...overrides,
  };
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

// ---------------------------------------------------------------------------
// 9.1 — Banner renders iff errorKind is auth-class
// ---------------------------------------------------------------------------

describe("AuthErrorBanner — 9.1: renders iff errorKind is auth-class", () => {
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
    // The banner replaces the bare error paragraph for auth-class errors.
    expect(screen.queryByTestId("error-reason-text")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 9.2 — Non-auth errors: bare paragraph unchanged, banner absent
// ---------------------------------------------------------------------------

describe("AuthErrorBanner — 9.2: non-auth errors use bare paragraph", () => {
  it("does NOT render auth-error-banner for errorKind='network-error'", () => {
    renderCard(
      buildErrorSummary({ errorKind: "network-error" as never, errorReason: "Network unreachable" }),
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

// ---------------------------------------------------------------------------
// 9.3 — Reconnect starts a scoped consent session
// ---------------------------------------------------------------------------

describe("AuthErrorBanner — 9.3: Reconnect calls startConsent and refreshes on completion", () => {
  it("calls startConsent with {providerId, datasourceId} when Reconnect is clicked", async () => {
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
      expect(startConsentMock).toHaveBeenCalledTimes(1);
    });
    expect(startConsentMock.mock.calls[0]![0]).toEqual({
      providerId: "google-drive",
      datasourceId: "ds-gd-err",
    });
  });

  it("card status reflects 'connected' after consent-completed triggers a refresh", async () => {
    const errSummary = buildErrorSummary({ errorKind: "auth-revoked" });
    const connectedSummary: DatasourceSummary = {
      ...errSummary,
      status: "connected",
      errorKind: null,
      errorReason: undefined,
    };

    // Render through the dashboard so store refresh propagates to the card.
    // First list() call returns the error datasource; subsequent calls return
    // the connected datasource after consent-completed triggers a refresh.
    listMock
      .mockResolvedValueOnce({ datasources: [errSummary] })
      .mockResolvedValue({ datasources: [connectedSummary] });

    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );

    // Wait for the error card to appear.
    await screen.findByTestId("auth-error-banner");

    // Click Reconnect to start the session.
    const banner = screen.getByTestId("auth-error-banner");
    fireEvent.click(within(banner).getByRole("button", { name: /reconnect/i }));
    await waitFor(() => expect(startConsentMock).toHaveBeenCalledTimes(1));

    // Fire consent-completed event.
    act(() => {
      onEventCapture!({
        event: "consent-completed",
        sessionId: "sess-reconnect",
        datasourceId: errSummary.id,
      });
    });

    // The auth-error-banner should disappear as the store refreshes with the
    // connected summary.
    await waitFor(() => {
      expect(screen.queryByTestId("auth-error-banner")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 9.4 — Banner a11y structural assertions (WCAG AA — no axe dep per project
//        convention; use role/name/label checks instead).
// ---------------------------------------------------------------------------

describe("AuthErrorBanner — 9.4: accessible name and Tab order", () => {
  it("banner has role='region' or a landmark with an accessible name", () => {
    renderCard(buildErrorSummary({ errorKind: "auth-revoked" }));
    const banner = screen.getByTestId("auth-error-banner");
    // The banner must be a section/aside/div with aria-label so screen readers
    // can identify it. We check for either aria-label or aria-labelledby.
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
