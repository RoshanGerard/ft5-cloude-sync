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

describe("InvalidDatasourceState — credentials-form inline reconnect (amazon-s3)", () => {
  it("Reconnect reveals the inline access-key form and does NOT call authenticateStart directly", async () => {
    render(
      <InvalidDatasourceState
        providerId="amazon-s3"
        datasourceId="ds-9"
        onReconnectSucceeded={() => {}}
        onRequestRemove={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^reconnect$/i }));

    expect(await screen.findByLabelText(/access key id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/secret access key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/bucket/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^back$/i })).toBeInTheDocument();
    // The shared state does NOT call authenticateStart itself for the
    // credentials-form arm — the inline form owns that on submit.
    expect(authenticateStartMock).not.toHaveBeenCalled();
  });

  it("Back from the inline form returns to the reconnect prompt", async () => {
    render(
      <InvalidDatasourceState
        providerId="amazon-s3"
        datasourceId="ds-9"
        onReconnectSucceeded={() => {}}
        onRequestRemove={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^reconnect$/i }));
    expect(await screen.findByLabelText(/access key id/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));

    expect(
      screen.getByRole("button", { name: /^reconnect$/i }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/access key id/i)).not.toBeInTheDocument();
  });

  it("end-to-end: submitting the inline form threads the EXISTING datasourceId and fires onReconnectSucceeded (Risk c)", async () => {
    // The S3 form drives authenticateStart (credentials-form) +
    // authenticateComplete itself; extend the api mock with the complete
    // call and make start return the credentials-form kind.
    authenticateStartMock.mockResolvedValue({
      ok: true,
      result: {
        correlationId: "corr-s3",
        kind: "credentials-form",
        formSchema: "aws-access-key",
      },
    });
    const authenticateCompleteMock = vi.fn().mockResolvedValue({
      ok: true,
      result: { datasourceId: "ds-9", summary: {} },
    });
    (
      window as unknown as {
        api: { sync: Record<string, unknown> };
      }
    ).api.sync.authenticateComplete = authenticateCompleteMock;

    const onReconnectSucceeded = vi.fn();
    render(
      <InvalidDatasourceState
        providerId="amazon-s3"
        datasourceId="ds-9"
        onReconnectSucceeded={onReconnectSucceeded}
        onRequestRemove={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^reconnect$/i }));
    fireEvent.change(await screen.findByLabelText(/access key id/i), {
      target: { value: "AKIA" },
    });
    fireEvent.change(screen.getByLabelText(/secret access key/i), {
      target: { value: "x" },
    });
    fireEvent.change(screen.getByLabelText(/region/i), {
      target: { value: "us-east-1" },
    });
    fireEvent.change(screen.getByLabelText(/bucket/i), {
      target: { value: "b" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );
    // The EXISTING datasourceId is threaded — not a freshly minted id.
    expect(authenticateStartMock.mock.calls[0]![0]).toEqual({
      providerId: "amazon-s3",
      datasourceId: "ds-9",
    });
    await waitFor(() =>
      expect(onReconnectSucceeded).toHaveBeenCalledTimes(1),
    );
  });
});

describe("InvalidDatasourceState — unknown providerId does not trap the user", () => {
  it("a defined-but-unregistered providerId falls through to authenticateStart (inline error) and keeps Reconnect + Remove reachable — no empty form arm", async () => {
    // Registry/version skew: providerId is present on the summary but not in
    // the frozen providers registry, so credentialsSchema is undefined. The
    // form arm MUST NOT be revealed (it would render an escape-less empty form).
    authenticateStartMock.mockResolvedValue({
      ok: false,
      error: { tag: "unknown-provider", providerId: "mystery", message: "no" },
    });

    render(
      <InvalidDatasourceState
        providerId="mystery-provider"
        datasourceId="ds-1"
        onReconnectSucceeded={() => {}}
        onRequestRemove={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^reconnect$/i }));

    // Falls through to authenticateStart (mirrors the pre-change behaviour).
    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );
    // No trapped empty form: the access-key field is NOT shown…
    expect(screen.queryByLabelText(/access key id/i)).not.toBeInTheDocument();
    // …and both prompt actions remain reachable.
    expect(
      screen.getByRole("button", { name: /^reconnect$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /remove datasource/i }),
    ).toBeInTheDocument();
  });
});

describe("InvalidDatasourceState — failed authenticateStart feedback (Decision 5)", () => {
  it("OAuth: authenticateStart {ok:false} surfaces an inline error instead of silently re-enabling", async () => {
    authenticateStartMock.mockResolvedValue({
      ok: false,
      error: {
        tag: "service-config-missing",
        path: "/cfg.json",
        providerId: "google-drive",
      },
    });

    render(
      <InvalidDatasourceState
        providerId="google-drive"
        datasourceId="ds-1"
        onReconnectSucceeded={() => {}}
        onRequestRemove={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^reconnect$/i }));

    await waitFor(() =>
      expect(authenticateStartMock).toHaveBeenCalledTimes(1),
    );
    expect(
      await screen.findByText(/service-config-missing/i),
    ).toBeInTheDocument();
  });
});
