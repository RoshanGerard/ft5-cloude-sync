/** @vitest-environment jsdom */
//
// implement-datasource-onboarding §23 — CustomForm migration tests.

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
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { SyncEvent } from "@ft5/ipc-contracts/sync-service-desktop";

import { DatasourcesProvider } from "../store";
import {
  CustomForm,
  type CustomFormProps,
} from "../credential-forms/custom-form";

let authenticateStartMock: Mock;
let authenticateCompleteMock: Mock;
let addMock: Mock;

const FIXTURE_SUMMARY = {
  id: "ds-custom-new",
  providerId: "amazon-s3" as const,
  displayName: "Custom",
  status: "connected" as const,
  errorReason: null,
  errorKind: null,
  paused: false,
  lastSyncAt: null,
  itemCount: 0,
};

function installApiMock() {
  authenticateStartMock = vi.fn().mockResolvedValue({
    ok: true,
    result: {
      correlationId: "corr-test",
      kind: "credentials-form",
      formSchema: "custom",
    },
  });
  authenticateCompleteMock = vi.fn().mockResolvedValue({
    ok: true,
    result: { datasourceId: "ds-custom-new", summary: FIXTURE_SUMMARY },
  });
  addMock = vi.fn();
  const syncOnEventMock = vi
    .fn()
    .mockImplementation((_cb: (e: SyncEvent) => void) => () => {});

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: addMock,
      remove: vi.fn(),
      action: vi.fn(),
      pickFilesToUpload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    sync: {
      listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      onEvent: syncOnEventMock,
      authenticateStart: authenticateStartMock,
      authenticateComplete: authenticateCompleteMock,
      authenticateCancel: vi
        .fn()
        .mockResolvedValue({ ok: true, result: { cancelled: true } }),
    },
  };
}

function renderForm(props: Partial<CustomFormProps> = {}) {
  const defaults: CustomFormProps = {
    providerId: "amazon-s3",
    providerDisplayName: "Custom",
    onSubmit: vi.fn(),
    onBack: vi.fn(),
  };
  return render(
    <DatasourcesProvider>
      <CustomForm {...defaults} {...props} />
    </DatasourcesProvider>,
  );
}

beforeEach(() => {
  installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CustomForm — migrated to sync.authenticate{Start,Complete}", () => {
  it("does not call any IPC on mount", async () => {
    renderForm();
    await act(async () => {});

    expect(authenticateStartMock).not.toHaveBeenCalled();
    expect(authenticateCompleteMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("submitting valid JSON drives authenticateStart then authenticateComplete with the parsed values", async () => {
    renderForm();
    await act(async () => {});

    const textarea = screen.getByLabelText(/custom credentials \(JSON\)/i);
    fireEvent.change(textarea, {
      target: { value: '{"foo":"bar","n":42}' },
    });

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(authenticateCompleteMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateCompleteMock.mock.calls[0]![0]).toEqual({
      correlationId: "corr-test",
      completion: {
        kind: "credentials-form",
        values: { foo: "bar", n: 42 },
      },
    });
  });

  it("reconnect path: a datasourceId prop is threaded into authenticateStart", async () => {
    renderForm({ datasourceId: "ds-9" });
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/custom credentials \(JSON\)/i), {
      target: { value: '{"x":1}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateStartMock.mock.calls[0]![0]).toEqual({
      providerId: "amazon-s3",
      datasourceId: "ds-9",
    });
  });

  it("add path: omits datasourceId from authenticateStart when the prop is absent", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/custom credentials \(JSON\)/i), {
      target: { value: '{"x":1}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    const arg = authenticateStartMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(arg).toEqual({ providerId: "amazon-s3" });
    expect("datasourceId" in arg).toBe(false);
  });

  it("does NOT call datasources.add at any point in the migrated flow", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/custom credentials \(JSON\)/i), {
      target: { value: '{"x":1}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(authenticateCompleteMock).toHaveBeenCalledTimes(1);
    });
    expect(addMock).not.toHaveBeenCalled();
  });

  it("invalid JSON shows inline parse error and does NOT call IPC", async () => {
    renderForm();
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/custom credentials \(JSON\)/i), {
      target: { value: "not-json" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    expect(authenticateStartMock).not.toHaveBeenCalled();
  });

  it("on authenticateComplete ok: false → inline error renders, onSubmit not called", async () => {
    authenticateCompleteMock.mockResolvedValue({
      ok: false,
      error: {
        tag: "engine-error",
        message: "engine rejected the credentials",
      },
    });
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/custom credentials \(JSON\)/i), {
      target: { value: '{"foo":"bar"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/engine rejected/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("on authenticateComplete ok: true → onSubmit fires with sentinel + datasourceId", async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    await act(async () => {});

    fireEvent.change(screen.getByLabelText(/custom credentials \(JSON\)/i), {
      target: { value: '{"x":1}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith({
      _authCompleted: "completed",
      datasourceId: "ds-custom-new",
    });
  });
});
