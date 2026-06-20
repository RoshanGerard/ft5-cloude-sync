/** @vitest-environment jsdom */
//
// implement-datasource-onboarding §23 — AwsAccessKeyForm migration tests.
//
// Migrates the form from `actions.add({providerId, credentials})` to the
// service-side two-step authenticate flow:
//
//   - Connect → window.api.sync.authenticateStart({providerId: "amazon-s3"})
//     returns { ok: true, result: { correlationId, kind: "credentials-form",
//     formSchema: "aws-access-key" } } or { ok: false, error: ... }
//   - User submits the form fields → window.api.sync.authenticateComplete(
//     {correlationId, completion: {kind: "credentials-form", values}})
//   - On ok: true → onSubmit({_authCompleted: "completed", datasourceId})
//   - On ok: false → inline error, retry available

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
  AwsAccessKeyForm,
  type AwsAccessKeyFormProps,
} from "../credential-forms/aws-access-key-form";

let authenticateStartMock: Mock;
let authenticateCompleteMock: Mock;
let authenticateCancelMock: Mock;
let addMock: Mock;

const FIXTURE_SUMMARY = {
  id: "ds-amazon-s3-new",
  providerId: "amazon-s3" as const,
  displayName: "S3 bucket",
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
      formSchema: "aws-access-key",
    },
  });
  authenticateCompleteMock = vi.fn().mockResolvedValue({
    ok: true,
    result: { datasourceId: "ds-amazon-s3-new", summary: FIXTURE_SUMMARY },
  });
  authenticateCancelMock = vi
    .fn()
    .mockResolvedValue({ ok: true, result: { cancelled: true } });
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
      authenticateCancel: authenticateCancelMock,
    },
  };
}

function renderForm(props: Partial<AwsAccessKeyFormProps> = {}) {
  const defaults: AwsAccessKeyFormProps = {
    providerId: "amazon-s3",
    providerDisplayName: "Amazon S3",
    onSubmit: vi.fn(),
    onBack: vi.fn(),
  };
  return render(
    <DatasourcesProvider>
      <AwsAccessKeyForm {...defaults} {...props} />
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

function fillFields(values: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
}) {
  fireEvent.change(screen.getByLabelText(/access key id/i), {
    target: { value: values.accessKeyId },
  });
  fireEvent.change(screen.getByLabelText(/secret access key/i), {
    target: { value: values.secretAccessKey },
  });
  fireEvent.change(screen.getByLabelText(/region/i), {
    target: { value: values.region },
  });
  fireEvent.change(screen.getByLabelText(/bucket/i), {
    target: { value: values.bucket },
  });
}

describe("AwsAccessKeyForm — migrated to sync.authenticate{Start,Complete}", () => {
  it("does not call any IPC on mount", async () => {
    renderForm();
    await act(async () => {});

    expect(authenticateStartMock).not.toHaveBeenCalled();
    expect(authenticateCompleteMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("submitting valid values calls authenticateStart then authenticateComplete with the values", async () => {
    renderForm();
    await act(async () => {});

    fillFields({
      accessKeyId: "AKIAFIXTURE",
      secretAccessKey: "secret-fixture",
      region: "us-east-1",
      bucket: "my-bucket",
    });

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateStartMock.mock.calls[0]![0]).toEqual({
      providerId: "amazon-s3",
    });

    await waitFor(() => {
      expect(authenticateCompleteMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateCompleteMock.mock.calls[0]![0]).toEqual({
      correlationId: "corr-test",
      completion: {
        kind: "credentials-form",
        values: {
          accessKeyId: "AKIAFIXTURE",
          secretAccessKey: "secret-fixture",
          region: "us-east-1",
          bucket: "my-bucket",
        },
      },
    });
  });

  it("reconnect path: a datasourceId prop is threaded into authenticateStart", async () => {
    renderForm({ datasourceId: "ds-9" });
    await act(async () => {});

    fillFields({
      accessKeyId: "AKIA",
      secretAccessKey: "x",
      region: "us-east-1",
      bucket: "b",
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

    fillFields({
      accessKeyId: "AKIA",
      secretAccessKey: "x",
      region: "us-east-1",
      bucket: "b",
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

    fillFields({
      accessKeyId: "AKIA",
      secretAccessKey: "x",
      region: "us-east-1",
      bucket: "b",
    });

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(authenticateCompleteMock).toHaveBeenCalledTimes(1);
    });
    expect(addMock).not.toHaveBeenCalled();
  });

  it("on authenticateComplete ok: true → onSubmit fires with sentinel + datasourceId", async () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    await act(async () => {});

    fillFields({
      accessKeyId: "AKIA",
      secretAccessKey: "x",
      region: "us-east-1",
      bucket: "b",
    });

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit).toHaveBeenCalledWith({
      _authCompleted: "completed",
      datasourceId: "ds-amazon-s3-new",
    });
  });

  it("on authenticateComplete ok: false → inline error renders, onSubmit not called", async () => {
    authenticateCompleteMock.mockResolvedValue({
      ok: false,
      error: {
        tag: "engine-error",
        message: "InvalidAccessKeyId: The access key was not recognised",
      },
    });
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    await act(async () => {});

    fillFields({
      accessKeyId: "BAD",
      secretAccessKey: "wrong",
      region: "us-east-1",
      bucket: "b",
    });

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/InvalidAccessKeyId/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("on authenticateStart ok: false → inline error renders, authenticateComplete not called", async () => {
    authenticateStartMock.mockResolvedValue({
      ok: false,
      error: {
        tag: "engine-error",
        message: "Engine failed to construct S3 client",
      },
    });
    renderForm();
    await act(async () => {});

    fillFields({
      accessKeyId: "AKIA",
      secretAccessKey: "x",
      region: "us-east-1",
      bucket: "b",
    });

    fireEvent.click(screen.getByRole("button", { name: /^connect/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/engine failed/i);
    expect(authenticateCompleteMock).not.toHaveBeenCalled();
  });

  it("Connect is disabled until all fields are non-empty", async () => {
    renderForm();
    await act(async () => {});

    const connectBtn = screen.getByRole("button", { name: /^connect/i });
    expect(connectBtn).toBeDisabled();

    fillFields({
      accessKeyId: "AKIA",
      secretAccessKey: "x",
      region: "us-east-1",
      bucket: "b",
    });

    expect(screen.getByRole("button", { name: /^connect/i })).not.toBeDisabled();
  });
});
