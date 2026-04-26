/** @vitest-environment jsdom */
//
// Tasks 7.1–7.4 — InvalidDatasourceState component.
//
// 7.1: Render structure — icon, headline, body, both buttons; role="alert",
//      aria-live="polite", data-testid="file-explorer-state-invalid-datasource";
//      AlertTriangle icon carries `text-destructive` and `aria-hidden="true"`.
// 7.2: useConsentSession lifecycle — pending → spinner + buttons disabled;
//      completed → onReconnectSucceeded() fires exactly once;
//      cancelled / failed / timeout → buttons re-enable + inline error line.
// 7.3: providerId guard — undefined providerId disables Reconnect with
//      aria-disabled="true"; click does NOT call startConsent.
// 7.4: Remove button — click invokes onRequestRemove exactly once; Reconnect
//      not called.
//
// The component depends on `useConsentSession` from
// `@/features/datasources/store`; we mock that module so we don't need the
// full DatasourcesProvider context tree just to drive lifecycle states.

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
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import type { ConsentSessionState } from "@/features/datasources/store";

// Mock `useConsentSession` so we can drive sessionState transitions per test.
// Tests mutate `mockSessionState` BEFORE re-render to simulate event arrivals.
let mockSessionState: ConsentSessionState = { status: "pending" };

vi.mock("@/features/datasources/store", () => ({
  useConsentSession: () => mockSessionState,
}));

import { InvalidDatasourceState } from "../invalid-datasource";

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

let startConsentMock: Mock;

function installApiMock() {
  startConsentMock = vi.fn().mockResolvedValue({ sessionId: "sess-1" });
  (window as unknown as { api: unknown }).api = {
    datasources: {
      startConsent: startConsentMock,
    },
  };
}

beforeEach(() => {
  // Reset to baseline pending; each test sets the desired state explicitly.
  mockSessionState = { status: "pending" };
  installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 7.1 — Render structure
// ---------------------------------------------------------------------------

describe("InvalidDatasourceState — 7.1: render structure", () => {
  it("renders headline, body, and both action buttons", () => {
    render(
      <InvalidDatasourceState
        providerId="google-drive"
        datasourceId="ds-1"
        onReconnectSucceeded={() => {}}
        onRequestRemove={() => {}}
      />,
    );
    expect(
      screen.getByText("This datasource needs reconfiguring"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Its connection details are missing or invalid. Sign in again or remove the datasource and add it back.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /reconnect/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /remove datasource/i }),
    ).toBeInTheDocument();
  });

  it("uses role='alert', aria-live='polite', and the documented data-testid", () => {
    render(
      <InvalidDatasourceState
        providerId="google-drive"
        datasourceId="ds-1"
        onReconnectSucceeded={() => {}}
        onRequestRemove={() => {}}
      />,
    );
    const root = screen.getByTestId("file-explorer-state-invalid-datasource");
    expect(root).toHaveAttribute("role", "alert");
    expect(root).toHaveAttribute("aria-live", "polite");
  });

  it("renders the AlertTriangle icon as text-destructive aria-hidden", () => {
    render(
      <InvalidDatasourceState
        providerId="google-drive"
        datasourceId="ds-1"
        onReconnectSucceeded={() => {}}
        onRequestRemove={() => {}}
      />,
    );
    const root = screen.getByTestId("file-explorer-state-invalid-datasource");
    const svg = root.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.classList.toString()).toContain("text-destructive");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// 7.2 — useConsentSession lifecycle (pending / completed / failed)
// ---------------------------------------------------------------------------

describe("InvalidDatasourceState — 7.2: useConsentSession lifecycle", () => {
  it("pending: both buttons disabled and Reconnect renders a spinner with 'Connecting…' label", async () => {
    mockSessionState = { status: "pending" };

    const { rerender } = render(
      <InvalidDatasourceState
        providerId="google-drive"
        datasourceId="ds-1"
        onReconnectSucceeded={() => {}}
        onRequestRemove={() => {}}
      />,
    );

    // Click Reconnect to assign the local sessionId; once startConsent
    // resolves, the component switches into "waiting" mode using
    // mockSessionState (still "pending") to drive the spinner.
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    await waitFor(() => expect(startConsentMock).toHaveBeenCalledTimes(1));

    // Re-render so the post-resolve state flushes.
    rerender(
      <InvalidDatasourceState
        providerId="google-drive"
        datasourceId="ds-1"
        onReconnectSucceeded={() => {}}
        onRequestRemove={() => {}}
      />,
    );

    const reconnectBtn = screen.getByRole("button", { name: /connecting/i });
    expect(reconnectBtn).toBeDisabled();

    const removeBtn = screen.getByRole("button", { name: /remove datasource/i });
    expect(removeBtn).toBeDisabled();

    // Spinner: an svg with the `animate-spin` class is present in the
    // Reconnect button.
    const spinner = within(reconnectBtn).getByTestId(
      "invalid-datasource-spinner",
    );
    expect(spinner.classList.toString()).toContain("animate-spin");
  });

  it("completed: invokes onReconnectSucceeded exactly once", async () => {
    const onReconnectSucceeded = vi.fn();
    mockSessionState = { status: "pending" };

    const { rerender } = render(
      <InvalidDatasourceState
        providerId="google-drive"
        datasourceId="ds-1"
        onReconnectSucceeded={onReconnectSucceeded}
        onRequestRemove={() => {}}
      />,
    );

    // Kick off the consent session so the component records sessionId.
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    await waitFor(() => expect(startConsentMock).toHaveBeenCalledTimes(1));

    // Flip the consent state to completed and re-render.
    mockSessionState = { status: "completed", datasourceId: "ds-1" };
    rerender(
      <InvalidDatasourceState
        providerId="google-drive"
        datasourceId="ds-1"
        onReconnectSucceeded={onReconnectSucceeded}
        onRequestRemove={() => {}}
      />,
    );

    expect(onReconnectSucceeded).toHaveBeenCalledTimes(1);

    // Re-render again with the same completed state — must still be exactly
    // one invocation (single-fire ref guard, not just useEffect dep).
    rerender(
      <InvalidDatasourceState
        providerId="google-drive"
        datasourceId="ds-1"
        onReconnectSucceeded={onReconnectSucceeded}
        onRequestRemove={() => {}}
      />,
    );
    expect(onReconnectSucceeded).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["cancelled", { status: "cancelled" } as ConsentSessionState],
    [
      "failed",
      {
        status: "failed",
        tag: "invalid-datasource",
      } as ConsentSessionState,
    ],
    ["timeout", { status: "timeout" } as ConsentSessionState],
  ])(
    "%s: re-enables both buttons, removes spinner, and shows inline 'Reconnect failed' line",
    async (_label, terminalState) => {
      mockSessionState = { status: "pending" };

      const { rerender } = render(
        <InvalidDatasourceState
          providerId="google-drive"
          datasourceId="ds-1"
          onReconnectSucceeded={() => {}}
          onRequestRemove={() => {}}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
      await waitFor(() => expect(startConsentMock).toHaveBeenCalledTimes(1));

      // Flip to terminal state.
      mockSessionState = terminalState;
      rerender(
        <InvalidDatasourceState
          providerId="google-drive"
          datasourceId="ds-1"
          onReconnectSucceeded={() => {}}
          onRequestRemove={() => {}}
        />,
      );

      const reconnectBtn = screen.getByRole("button", { name: /reconnect/i });
      expect(reconnectBtn).not.toBeDisabled();

      const removeBtn = screen.getByRole("button", {
        name: /remove datasource/i,
      });
      expect(removeBtn).not.toBeDisabled();

      // Spinner gone.
      expect(
        screen.queryByTestId("invalid-datasource-spinner"),
      ).not.toBeInTheDocument();

      // Inline error message visible.
      expect(
        screen.getByText("Reconnect failed — please try again."),
      ).toBeInTheDocument();
    },
  );
});

// ---------------------------------------------------------------------------
// 7.3 — providerId guard
// ---------------------------------------------------------------------------

describe("InvalidDatasourceState — 7.3: providerId guard", () => {
  it("Reconnect carries aria-disabled='true' and a tooltip when providerId is undefined; click does NOT call startConsent", () => {
    render(
      <InvalidDatasourceState
        datasourceId="ds-1"
        onReconnectSucceeded={() => {}}
        onRequestRemove={() => {}}
      />,
    );

    const reconnectBtn = screen.getByRole("button", { name: /reconnect/i });
    expect(reconnectBtn).toHaveAttribute("aria-disabled", "true");
    expect(reconnectBtn).toHaveAttribute(
      "title",
      "Provider information unavailable — return to the dashboard to reconnect",
    );

    fireEvent.click(reconnectBtn);
    expect(startConsentMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7.4 — Remove button → onRequestRemove
// ---------------------------------------------------------------------------

describe("InvalidDatasourceState — 7.4: Remove button", () => {
  it("invokes onRequestRemove exactly once when clicked; does NOT call startConsent", () => {
    const onRequestRemove = vi.fn();
    render(
      <InvalidDatasourceState
        providerId="google-drive"
        datasourceId="ds-1"
        onReconnectSucceeded={() => {}}
        onRequestRemove={onRequestRemove}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /remove datasource/i }),
    );
    expect(onRequestRemove).toHaveBeenCalledTimes(1);
    expect(startConsentMock).not.toHaveBeenCalled();
  });
});
