/** @vitest-environment jsdom */
//
// Tasks 10.1–10.4 — InvalidDatasourceBanner in DatasourceCard.
//
// 10.1: Banner renders iff `summary.status === "error" &&
//       summary.errorKind === "invalid-datasource"`. Reconnect calls
//       startConsent({providerId, datasourceId}); Remove opens the shared
//       <ConfirmRemoveDatasourceDialog>; consent-completed unmounts the
//       banner via summary refresh.
// 10.2: Banner does NOT render for non-invalid-datasource errorKinds.
//       network-error → bare <p>; auth-revoked → <AuthErrorBanner>.
// 10.3: A11y — no axe dep per project convention (see
//       features/datasources/__tests__/a11y.test.tsx header). Structural
//       assertions: aria-label present + non-empty; both action buttons have
//       non-empty accessible names; DOM order is Reconnect → Remove (which
//       equals tab order without explicit tabIndex overrides).
//
// Harness mirrors card-auth-error-banner.test.tsx verbatim — same
// installApiMock, buildErrorSummary, renderCard helpers — so contributors
// reading both tests pick up the pattern without context-switching.

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
let removeMock: Mock;
let listMock: Mock;
let onEventCapture: ((event: unknown) => void) | null = null;

function installApiMock() {
  startConsentMock = vi
    .fn()
    .mockResolvedValue({ sessionId: "sess-reconnect" });
  removeMock = vi.fn().mockResolvedValue({ ok: true });
  listMock = vi.fn().mockResolvedValue({ datasources: [] });
  onEventCapture = null;

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: listMock,
      add: vi.fn(),
      remove: removeMock,
      action: vi.fn(),
      startConsent: startConsentMock,
      cancelConsent: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockImplementation((cb: (e: unknown) => void) => {
        onEventCapture = cb;
        return () => {
          onEventCapture = null;
        };
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
    errorReason: "Credentials are missing — reconnect this datasource",
    errorKind: "invalid-datasource",
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
// 10.1 — Banner renders iff errorKind is invalid-datasource
// ---------------------------------------------------------------------------

describe("InvalidDatasourceBanner — 10.1: renders iff errorKind is invalid-datasource", () => {
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

  it("Reconnect click calls startConsent with {providerId, datasourceId} exactly once", async () => {
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
      expect(startConsentMock).toHaveBeenCalledTimes(1);
    });
    expect(startConsentMock.mock.calls[0]![0]).toEqual({
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

    // Dialog is portalled — query at document level, not inside the banner.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // IPC must NOT fire on dialog-open alone.
    expect(removeMock).not.toHaveBeenCalled();

    // Click the destructive Remove inside the dialog (exact-match label to
    // avoid colliding with the trigger).
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(removeMock).toHaveBeenCalledTimes(1);
    });
    expect(removeMock.mock.calls[0]![0]).toEqual({ datasourceId: "ds-gd-err" });
  });

  it("banner unmounts when consent-completed flips the summary back to connected", async () => {
    const errSummary = buildErrorSummary({ errorKind: "invalid-datasource" });
    const connectedSummary: DatasourceSummary = {
      ...errSummary,
      status: "connected",
      errorKind: null,
      errorReason: undefined,
    };

    // First list() returns the errored summary; subsequent list() (after
    // consent-completed triggers a refresh) returns the connected summary.
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
    await waitFor(() => expect(startConsentMock).toHaveBeenCalledTimes(1));

    act(() => {
      onEventCapture!({
        event: "consent-completed",
        sessionId: "sess-reconnect",
        datasourceId: errSummary.id,
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("invalid-datasource-banner"),
      ).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 10.2 — Banner does NOT render for other errorKinds
// ---------------------------------------------------------------------------

describe("InvalidDatasourceBanner — 10.2: does NOT render for other errorKinds", () => {
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

// ---------------------------------------------------------------------------
// 10.3 — Structural a11y assertions (no axe dep per project convention; see
//        features/datasources/__tests__/a11y.test.tsx header for the rationale)
// ---------------------------------------------------------------------------

describe("InvalidDatasourceBanner — 10.3: structural a11y", () => {
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

  it("tab order inside the banner is Reconnect → Remove (DOM order proxies tab order without explicit tabIndex)", () => {
    renderCard(buildErrorSummary({ errorKind: "invalid-datasource" }));
    const banner = screen.getByTestId("invalid-datasource-banner");
    const buttons = banner.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons[0]!.textContent?.toLowerCase()).toMatch(/reconnect/);
    expect(buttons[1]!.textContent?.toLowerCase()).toMatch(/^remove$/);
    // No tabIndex override would break that mapping:
    expect(buttons[0]!.getAttribute("tabindex")).toBeNull();
    expect(buttons[1]!.getAttribute("tabindex")).toBeNull();
  });
});
