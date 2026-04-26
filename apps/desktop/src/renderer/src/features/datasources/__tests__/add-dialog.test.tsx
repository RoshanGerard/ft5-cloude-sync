/** @vitest-environment jsdom */
//
// implement-datasource-onboarding §24 — AddDatasourceDialog tests.
//
// Wraps the whole dashboard in a `<DatasourcesProvider>` and exercises the
// add-datasource flow end-to-end against a fully-mocked `window.api` surface.
// Post-§22+§23 the credential forms drive the service-side authenticate flow
// directly:
//
//   - OAuth form: form calls window.api.sync.authenticateStart, listens for
//     auth-completed via window.api.sync.onEvent, signals completion to the
//     dialog via the `_authCompleted: "completed"` sentinel.
//   - Credentials-form (AWS / custom): form calls authenticateStart +
//     authenticateComplete inline, signals completion via the same sentinel.
//
// On either sentinel the dialog calls actions.refresh() (NOT actions.add)
// and closes. The dialog itself never calls window.api.datasources.add.

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
import type { SyncEvent } from "@ft5/ipc-contracts/sync-service-desktop";

// Task 8.2 added `useRouter()` to DatasourceCard. The add-dialog happy-path
// tests render a real card (verifying the new datasource appears in the
// grid), so we need the App-Router mock here too to avoid Next's "invariant
// expected app router to be mounted" throw.
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
let authenticateStartMock: Mock;
let authenticateCompleteMock: Mock;
let authenticateCancelMock: Mock;
// Captures the onEvent listener registered by DatasourcesProvider so tests
// can fire synthetic auth-* events.
let syncOnEventCapture: ((event: SyncEvent) => void) | null = null;

function installApiMock() {
  authenticateStartMock = vi.fn().mockResolvedValue({
    ok: true,
    result: { correlationId: "corr-add-dialog", kind: "oauth" },
  });
  authenticateCompleteMock = vi.fn();
  authenticateCancelMock = vi
    .fn()
    .mockResolvedValue({ ok: true, result: { cancelled: true } });
  syncOnEventCapture = null;

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: listMock,
      add: addMock,
      remove: removeMock,
      action: actionMock,
      pickFilesToUpload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    sync: {
      listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      onEvent: vi.fn().mockImplementation((cb: (e: SyncEvent) => void) => {
        syncOnEventCapture = cb;
        return () => {
          syncOnEventCapture = null;
        };
      }),
      authenticateStart: authenticateStartMock,
      authenticateComplete: authenticateCompleteMock,
      authenticateCancel: authenticateCancelMock,
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
    errorReason: null,
    errorKind: null,
    paused: false,
    lastSyncAt: null,
    itemCount: 0,
    usage: { used: 0, quota: 1_000_000_000 },
    ...overrides,
  } as DatasourceSummary;
}

function renderDashboard() {
  return render(
    <DatasourcesProvider>
      <DatasourcesDashboard />
    </DatasourcesProvider>,
  );
}

async function openDialog(): Promise<HTMLElement> {
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
  installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AddDatasourceDialog", () => {
  it("opens from the dashboard toolbar trigger", async () => {
    renderDashboard();

    await screen.findByTestId("datasources-empty");
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

    const expectedIds = Object.keys(providers);
    for (const id of expectedIds) {
      const option = within(dialog).getByTestId(`provider-option-${id}`);
      expect(option).toBeInTheDocument();
    }

    const allOptions = within(dialog).getAllByTestId(/^provider-option-/);
    expect(allOptions.length).toBe(expectedIds.length);

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
        const connect = await within(dialog).findByRole("button", {
          name: /^connect/i,
        });
        expect(connect).toBeInTheDocument();
      } else if (schema === "aws-access-key") {
        const accessKey = await within(dialog).findByLabelText(
          /access key id/i,
        );
        expect(accessKey).toBeInTheDocument();
        expect(
          within(dialog).getByLabelText(/secret access key/i),
        ).toBeInTheDocument();
        expect(within(dialog).getByLabelText(/bucket/i)).toBeInTheDocument();
      }
    });
  });

  it("OAuth form (google-drive): authenticateStart + auth-completed → refresh + close + new card", async () => {
    const returnedSummary = buildSummary({
      id: "ds-gd-1",
      displayName: "My Personal Drive",
      providerId: "google-drive",
    });
    // First list() call returns empty; subsequent calls (refresh after
    // auth-completed) return the new ds.
    listMock
      .mockResolvedValueOnce({ datasources: [] })
      .mockResolvedValue({ datasources: [returnedSummary] });

    renderDashboard();
    await screen.findByTestId("datasources-empty");
    const trigger = screen.getByTestId("add-datasource-trigger");
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

    // sync.authenticateStart must be called; datasources.add must NOT be called.
    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    expect(addMock).not.toHaveBeenCalled();
    expect(authenticateStartMock.mock.calls[0]![0]).toMatchObject({
      providerId: "google-drive",
    });

    // Fire the auth-completed event through the captured sync.onEvent listener.
    act(() => {
      syncOnEventCapture!({
        kind: "auth-completed",
        payload: {
          correlationId: "corr-add-dialog",
          datasourceId: returnedSummary.id,
          summary: returnedSummary,
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });

    await waitFor(() => {
      expect(
        screen.getByText(returnedSummary.displayName),
      ).toBeInTheDocument();
    });
  });

  it("submitting the AWS access-key form drives sync.authenticate{Start,Complete}, refreshes, and closes — does NOT call datasources.add", async () => {
    const returnedSummary = buildSummary({
      id: "ds-s3-1",
      displayName: "Archive Bucket",
      providerId: "amazon-s3",
    });
    authenticateStartMock.mockResolvedValueOnce({
      ok: true,
      result: {
        correlationId: "corr-aws-1",
        kind: "credentials-form",
        formSchema: "aws-access-key",
      },
    });
    authenticateCompleteMock.mockResolvedValueOnce({
      ok: true,
      result: { datasourceId: returnedSummary.id, summary: returnedSummary },
    });
    listMock
      .mockResolvedValueOnce({ datasources: [] })
      .mockResolvedValue({ datasources: [returnedSummary] });

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

    const submit = within(dialog).getByRole("button", {
      name: /^connect|^add|^submit/i,
    });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateStartMock.mock.calls[0]![0]).toMatchObject({
      providerId: "amazon-s3",
    });

    await waitFor(() => {
      expect(authenticateCompleteMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateCompleteMock.mock.calls[0]![0]).toMatchObject({
      correlationId: "corr-aws-1",
      completion: {
        kind: "credentials-form",
        values: expect.objectContaining({
          accessKeyId: "AKIAEXAMPLE",
          secretAccessKey: "s3cretValue",
          bucket: "backup-bucket",
        }),
      },
    });

    // datasources.add MUST NOT be called — the form drives the service flow.
    expect(addMock).not.toHaveBeenCalled();

    // Dialog closes after sentinel-driven onSubmit fires.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("Back button returns to step 1", async () => {
    renderDashboard();
    const dialog = await openDialog();

    const option = within(dialog).getByTestId("provider-option-google-drive");
    fireEvent.click(option);

    await within(dialog).findByRole("button", { name: /^connect/i });

    const back = within(dialog).getByRole("button", { name: /^back/i });
    fireEvent.click(back);

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
    expect(
      within(dialog).queryByRole("button", { name: /^connect/i }),
    ).toBeNull();
  });

  it("closing the dialog via Escape does NOT call datasources.add", async () => {
    renderDashboard();
    const dialog = await openDialog();

    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(addMock).not.toHaveBeenCalled();
  });
});
