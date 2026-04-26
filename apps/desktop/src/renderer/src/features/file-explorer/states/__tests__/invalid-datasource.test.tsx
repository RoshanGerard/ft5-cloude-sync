/** @vitest-environment jsdom */
//
// implement-datasource-onboarding §27 — InvalidDatasourceState migration tests.
//
// 27.1: useAuthSession lifecycle — pending / completed / failed / timeout.
//       pending → buttons disabled + label "Connecting…";
//       completed → onReconnectSucceeded() fires exactly once;
//       cancelled / failed / timeout → buttons re-enable + inline error line.
// 27.2: Reconnect calls window.api.sync.authenticateStart({providerId,
//       datasourceId}); records the returned correlationId.
// 27.3: providerId guard — undefined providerId disables Reconnect with
//       aria-disabled="true"; click does NOT call sync.authenticateStart.
// 27.4: Remove button → onRequestRemove exactly once.
//
// `useAuthSession` is mocked at the module boundary so we can drive
// sessionState transitions per test without the full DatasourcesProvider tree.

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
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import type { AuthSessionState } from "@/features/datasources/store";

let mockSessionState: AuthSessionState = { status: "pending" };

vi.mock("@/features/datasources/store", () => ({
  useAuthSession: () => mockSessionState,
}));

import { InvalidDatasourceState } from "../invalid-datasource";

let authenticateStartMock: Mock;

function installApiMock() {
  authenticateStartMock = vi.fn().mockResolvedValue({
    ok: true,
    result: { correlationId: "corr-1", kind: "oauth" },
  });
  (window as unknown as { api: unknown }).api = {
    sync: {
      authenticateStart: authenticateStartMock,
    },
  };
}

beforeEach(() => {
  mockSessionState = { status: "pending" };
  installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InvalidDatasourceState — render structure", () => {
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

describe("InvalidDatasourceState — useAuthSession lifecycle", () => {
  it("pending: both buttons disabled and Reconnect label switches to 'Connecting…'", async () => {
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
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );

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
    expect(reconnectBtn.textContent).toContain("Connecting…");

    const removeBtn = screen.getByRole("button", {
      name: /remove datasource/i,
    });
    expect(removeBtn).toBeDisabled();
  });

  it("Reconnect calls sync.authenticateStart with {providerId, datasourceId}", async () => {
    render(
      <InvalidDatasourceState
        providerId="google-drive"
        datasourceId="ds-42"
        onReconnectSucceeded={() => {}}
        onRequestRemove={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );
    expect(authenticateStartMock.mock.calls[0]![0]).toEqual({
      providerId: "google-drive",
      datasourceId: "ds-42",
    });
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

    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );

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
    ["cancelled", { status: "cancelled" } as AuthSessionState],
    [
      "failed",
      {
        status: "failed",
        tag: "auth-revoked",
      } as AuthSessionState,
    ],
    ["timeout", { status: "timeout" } as AuthSessionState],
  ])(
    "%s: re-enables both buttons and shows inline 'Reconnect failed' line",
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
      await waitFor(() =>
        expect(authenticateStartMock).toHaveBeenCalledTimes(1),
      );

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
      expect(reconnectBtn.textContent).toContain("Reconnect");

      const removeBtn = screen.getByRole("button", {
        name: /remove datasource/i,
      });
      expect(removeBtn).not.toBeDisabled();

      expect(
        screen.getByText("Reconnect failed — please try again."),
      ).toBeInTheDocument();
    },
  );
});

describe("InvalidDatasourceState — providerId guard", () => {
  it("Reconnect carries aria-disabled='true' when providerId is undefined; click does NOT call sync.authenticateStart", () => {
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
    expect(authenticateStartMock).not.toHaveBeenCalled();
  });
});

describe("InvalidDatasourceState — Remove button", () => {
  it("invokes onRequestRemove exactly once when clicked; does NOT call sync.authenticateStart", () => {
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
    expect(authenticateStartMock).not.toHaveBeenCalled();
  });
});
