/** @vitest-environment jsdom */
//
// Phase 6.1 — AddDatasourceDialog tests (RED stage).
//
// Wraps the whole dashboard in a `<DatasourcesProvider>` and exercises the
// add-datasource flow end-to-end against a fully-mocked `window.api` surface:
//
//   - toolbar trigger opens the dialog
//   - step 1 renders exactly the registry's providers
//   - selecting a provider advances to step 2 with the credential form
//     picked off `credentialsSchema` (parameterized over all three)
//   - OAuth submit and AWS access-key submit both call `add()` with the
//     correct shape, close the dialog, return focus to the trigger, and
//     surface the new card on the dashboard grid
//   - Back button returns to step 1
//   - Close/X/Escape does NOT call add()
//
// Notes on shape:
//   - The OAuth form exposes a `delayMs` prop so tests pass `0` and avoid
//     `vi.useFakeTimers()` plumbing — React async + fake timers is a known
//     footgun under @testing-library. The real default stays at 800ms (set
//     by `add-dialog.tsx`, not the test).
//   - Radix Dialog restores focus asynchronously after close, so focus
//     assertions use `waitFor(() => expect(document.activeElement).toBe(...))`.
//   - ResizeObserver polyfilled for jsdom (Radix DropdownMenu / Dialog depend
//     on it at mount).

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
import { providers } from "@ft5/ipc-contracts";

// Task 8.2 added `useRouter()` to DatasourceCard. The add-dialog happy-path
// tests render a real card (verifying the new datasource appears in the
// grid), so we need the App-Router mock here too to avoid Next's "invariant
// expected app router to be mounted" throw. Same hoisted-mock pattern as
// card.test.tsx / dashboard.test.tsx.
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

import { DatasourcesProvider } from "../store";
import { DatasourcesDashboard } from "../dashboard";

let listMock: Mock;
let addMock: Mock;
let removeMock: Mock;
let actionMock: Mock;
let uploadMock: Mock;
let startConsentMock: Mock;
// Captures the onEvent listener registered by DatasourcesProvider so tests
// can fire synthetic consent events.
let onEventCapture: ((event: unknown) => void) | null = null;

function installApiMock() {
  startConsentMock = vi
    .fn()
    .mockResolvedValue({ sessionId: "sess-add-dialog" });
  onEventCapture = null;

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: listMock,
      add: addMock,
      remove: removeMock,
      action: actionMock,
      upload: uploadMock,
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

function buildSummary(
  overrides: Partial<DatasourceSummary> = {},
): DatasourceSummary {
  return {
    id: "ds-new",
    displayName: "Freshly Connected",
    providerId: "google-drive",
    status: "connected",
    lastSyncAt: null,
    itemCount: 0,
    usage: { used: 0, quota: 1_000_000_000 },
    ...overrides,
  };
}

function renderDashboard() {
  return render(
    <DatasourcesProvider>
      <DatasourcesDashboard />
    </DatasourcesProvider>,
  );
}

async function openDialog(): Promise<HTMLElement> {
  // Wait for the empty-state render (list resolved with []) so the toolbar
  // trigger is present and stable.
  await screen.findByTestId("datasources-empty");
  const trigger = screen.getByTestId("add-datasource-trigger");
  fireEvent.click(trigger);
  return await screen.findByRole("dialog", { name: /add datasource/i });
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
  listMock = vi.fn().mockResolvedValue({ datasources: [] });
  addMock = vi.fn();
  removeMock = vi.fn();
  actionMock = vi.fn();
  uploadMock = vi.fn();
  installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AddDatasourceDialog — task 6.1", () => {
  it("opens from the dashboard toolbar trigger", async () => {
    renderDashboard();

    await screen.findByTestId("datasources-empty");
    // Dialog is not yet rendered.
    expect(screen.queryByRole("dialog")).toBeNull();

    const trigger = screen.getByTestId("add-datasource-trigger");
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", {
      name: /add datasource/i,
    });
    expect(dialog).toBeInTheDocument();
  });

  it("step 1 lists exactly the providers from the registry", async () => {
    renderDashboard();
    const dialog = await openDialog();

    // One picker option per entry in `providers`. Query by descriptor
    // ID via a stable data attribute, NOT by hardcoded strings, so adding a
    // fourth provider to the registry immediately surfaces four options.
    const expectedIds = Object.keys(providers);
    for (const id of expectedIds) {
      const option = within(dialog).getByTestId(`provider-option-${id}`);
      expect(option).toBeInTheDocument();
    }

    // And no other provider options beyond the registry.
    const allOptions = within(dialog).getAllByTestId(/^provider-option-/);
    expect(allOptions.length).toBe(expectedIds.length);

    // Each shows the provider's display name.
    for (const id of expectedIds) {
      const option = within(dialog).getByTestId(`provider-option-${id}`);
      const descriptor = providers[id as keyof typeof providers];
      expect(option.textContent).toContain(descriptor.displayName);
    }
  });

  describe.each([
    ["google-drive", "oauth"] as const,
    ["onedrive", "oauth"] as const,
    ["amazon-s3", "aws-access-key"] as const,
  ])("selecting provider %s → credential form (%s)", (providerId, schema) => {
    it(`advances to step 2 and renders the matching credential form`, async () => {
      renderDashboard();
      const dialog = await openDialog();

      const option = within(dialog).getByTestId(`provider-option-${providerId}`);
      fireEvent.click(option);

      if (schema === "oauth") {
        // OAuth form — look for the Connect button.
        const connect = await within(dialog).findByRole("button", {
          name: /^connect/i,
        });
        expect(connect).toBeInTheDocument();
      } else if (schema === "aws-access-key") {
        // AWS access-key form — look for the three primary inputs.
        const accessKey = await within(dialog).findByLabelText(
          /access key id/i,
        );
        expect(accessKey).toBeInTheDocument();
        expect(
          within(dialog).getByLabelText(/secret access key/i),
        ).toBeInTheDocument();
        expect(
          within(dialog).getByLabelText(/bucket/i),
        ).toBeInTheDocument();
      }
    });
  });

  it("OAuth form (google-drive) calls startConsent, consent-completed triggers refresh and closes the dialog", async () => {
    const returnedSummary = buildSummary({
      id: "ds-gd-1",
      displayName: "My Personal Drive",
      providerId: "google-drive",
    });
    // Second list() call (refresh after consent-completed) returns the new ds.
    listMock
      .mockResolvedValueOnce({ datasources: [] })
      .mockResolvedValue({ datasources: [returnedSummary] });

    renderDashboard();
    await screen.findByTestId("datasources-empty");
    const trigger = screen.getByTestId("add-datasource-trigger");
    // Focus the trigger before opening so Radix has a meaningful element to
    // restore focus to on close.
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", {
      name: /add datasource/i,
    });
    const option = within(dialog).getByTestId("provider-option-google-drive");
    fireEvent.click(option);

    const connect = await within(dialog).findByRole("button", {
      name: /^connect/i,
    });
    fireEvent.click(connect);

    // startConsent must be called; add() must NOT be called.
    await waitFor(() => {
      expect(startConsentMock).toHaveBeenCalledTimes(1);
    });
    expect(addMock).not.toHaveBeenCalled();
    expect(startConsentMock.mock.calls[0]![0]).toMatchObject({
      providerId: "google-drive",
    });

    // Fire the consent-completed event through the captured onEvent listener.
    act(() => {
      onEventCapture!({
        event: "consent-completed",
        sessionId: "sess-add-dialog",
        datasourceId: returnedSummary.id,
      });
    });

    // Dialog closes.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Focus returns to the toolbar trigger (Radix restores async).
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });

    // New card appears after refresh.
    await waitFor(() => {
      expect(screen.getByText(returnedSummary.displayName)).toBeInTheDocument();
    });
  });

  it("submitting the AWS access-key form calls add() with typed credentials", async () => {
    const returnedSummary = buildSummary({
      id: "ds-s3-1",
      displayName: "Archive Bucket",
      providerId: "amazon-s3",
    });
    addMock.mockResolvedValue({ datasource: returnedSummary });

    renderDashboard();
    const dialog = await openDialog();

    const option = within(dialog).getByTestId("provider-option-amazon-s3");
    fireEvent.click(option);

    const accessKey = await within(dialog).findByLabelText(/access key id/i);
    const secret = within(dialog).getByLabelText(/secret access key/i);
    const bucket = within(dialog).getByLabelText(/bucket/i);

    fireEvent.change(accessKey, { target: { value: "AKIAEXAMPLE" } });
    fireEvent.change(secret, { target: { value: "s3cretValue" } });
    fireEvent.change(bucket, { target: { value: "backup-bucket" } });

    const submit = within(dialog).getByRole("button", { name: /^connect|^add|^submit/i });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(addMock).toHaveBeenCalledTimes(1);
    });
    const call = addMock.mock.calls[0]![0] as {
      providerId: string;
      credentials: Record<string, unknown>;
    };
    expect(call.providerId).toBe("amazon-s3");
    expect(call.credentials).toMatchObject({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "s3cretValue",
      bucket: "backup-bucket",
    });
  });

  it("Back button returns to step 1", async () => {
    renderDashboard();
    const dialog = await openDialog();

    const option = within(dialog).getByTestId("provider-option-google-drive");
    fireEvent.click(option);

    // We're on step 2 — Connect is present.
    await within(dialog).findByRole("button", { name: /^connect/i });

    // Click Back.
    const back = within(dialog).getByRole("button", { name: /^back/i });
    fireEvent.click(back);

    // Back on step 1 — all three provider options are visible again.
    await waitFor(() => {
      expect(
        within(dialog).getByTestId("provider-option-google-drive"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByTestId("provider-option-onedrive"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByTestId("provider-option-amazon-s3"),
      ).toBeInTheDocument();
    });
    // Connect button is gone (we left step 2).
    expect(
      within(dialog).queryByRole("button", { name: /^connect/i }),
    ).toBeNull();
  });

  it("closing the dialog via Escape does NOT call add()", async () => {
    renderDashboard();
    const dialog = await openDialog();

    // Escape on the dialog.
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(addMock).not.toHaveBeenCalled();
  });
});
