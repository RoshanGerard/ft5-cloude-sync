import { DatasourceError } from "@ft5/fs-datasource-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEventBus, type EventBus } from "../events/event-bus.js";
import type {
  ExecutorCtx,
  ExecutorResult,
} from "../scheduler/scheduler.js";

import { buildUploadExecutor } from "./upload.js";

interface FakeClientOptions {
  readonly uploadFile?: (parent: unknown, file: unknown) => Promise<unknown>;
}

function fakeClient(opts: FakeClientOptions = {}): {
  client: unknown;
  uploadFileCalls: Array<[unknown, unknown]>;
} {
  const uploadFileCalls: Array<[unknown, unknown]> = [];
  const client = {
    type: "amazon-s3",
    datasourceId: "ds-1",
    uploadFile: vi.fn(async (parent: unknown, file: unknown) => {
      uploadFileCalls.push([parent, file]);
      if (opts.uploadFile) return opts.uploadFile(parent, file);
      return {
        id: "remote-id-1",
        name: "a.txt",
        path: "/remote/a.txt",
        size: 12,
        kind: "file",
      };
    }),
  };
  return { client, uploadFileCalls };
}

let bus: EventBus;
let emitted: Array<{ name: string; payload: unknown }>;

beforeEach(() => {
  bus = createEventBus();
  emitted = [];
  bus.subscribe((name, payload) => {
    emitted.push({ name, payload });
  });
});

afterEach(() => {
  emitted = [];
});

function makeCtx(opts: {
  signal?: AbortSignal;
  conflictPolicy?: "overwrite" | "duplicate" | "skip";
}): ExecutorCtx {
  return {
    job: {
      id: "j-1",
      kind: "upload",
      datasourceId: "ds-1",
      sourcePath: "/local/a.txt",
      targetPath: "/remote/a.txt",
      conflictPolicy: opts.conflictPolicy ?? "overwrite",
      status: "running",
      attempt: 1,
      lastErrorTag: null,
      lastErrorMessage: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    signal: opts.signal ?? new AbortController().signal,
    bus,
  };
}

describe("UploadJobExecutor — happy path", () => {
  it("calls client.uploadFile once with Target{kind:'path'} and {path: sourcePath}", async () => {
    const { client, uploadFileCalls } = fakeClient();
    const executor = buildUploadExecutor({
      factory: {} as never,
      resolveClient: async () => client as never,
    });
    const result: ExecutorResult = await executor(makeCtx({}));
    expect(result.outcome).toBe("completed");
    expect(uploadFileCalls).toHaveLength(1);
    expect(uploadFileCalls[0]).toEqual([
      { kind: "path", path: "/remote/a.txt" },
      { path: "/local/a.txt" },
    ]);
  });

  it("emits job-progress with 100% on completion", async () => {
    const { client } = fakeClient();
    const executor = buildUploadExecutor({
      factory: {} as never,
      resolveClient: async () => client as never,
    });
    await executor(makeCtx({}));
    const progress = emitted.find((e) => e.name === "job-progress");
    expect(progress).toBeTruthy();
    expect((progress?.payload as { percent: number }).percent).toBe(100);
  });
});

describe("UploadJobExecutor — conflict policy", () => {
  it("treats DatasourceError.tag='conflict' as completed when policy='skip'", async () => {
    const { client } = fakeClient({
      uploadFile: async () => {
        throw new DatasourceError({
          tag: "conflict",
          message: "file exists",
          retryable: false,
          datasourceId: "ds-1",
          datasourceType: "amazon-s3",
        });
      },
    });
    const executor = buildUploadExecutor({
      factory: {} as never,
      resolveClient: async () => client as never,
    });
    const result = await executor(makeCtx({ conflictPolicy: "skip" }));
    expect(result.outcome).toBe("completed");
  });

  it("propagates DatasourceError.tag='conflict' as failed when policy='overwrite'", async () => {
    const { client } = fakeClient({
      uploadFile: async () => {
        throw new DatasourceError({
          tag: "conflict",
          message: "file exists",
          retryable: false,
          datasourceId: "ds-1",
          datasourceType: "amazon-s3",
        });
      },
    });
    const executor = buildUploadExecutor({
      factory: {} as never,
      resolveClient: async () => client as never,
    });
    const result = await executor(makeCtx({ conflictPolicy: "overwrite" }));
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorTag).toBe("conflict");
    }
  });
});

describe("UploadJobExecutor — failure mapping", () => {
  it("maps network-error to outcome='waiting-network'", async () => {
    const { client } = fakeClient({
      uploadFile: async () => {
        throw new DatasourceError({
          tag: "network-error",
          message: "DNS",
          retryable: true,
          datasourceId: "ds-1",
          datasourceType: "amazon-s3",
        });
      },
    });
    const executor = buildUploadExecutor({
      factory: {} as never,
      resolveClient: async () => client as never,
    });
    const result = await executor(makeCtx({}));
    expect(result.outcome).toBe("waiting-network");
  });

  it("maps other DatasourceError tags to outcome='failed' with matching tag", async () => {
    const { client } = fakeClient({
      uploadFile: async () => {
        throw new DatasourceError({
          tag: "provider-error",
          message: "S3 500",
          retryable: true,
          datasourceId: "ds-1",
          datasourceType: "amazon-s3",
        });
      },
    });
    const executor = buildUploadExecutor({
      factory: {} as never,
      resolveClient: async () => client as never,
    });
    const result = await executor(makeCtx({}));
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") expect(result.errorTag).toBe("provider-error");
  });
});

describe("UploadJobExecutor — argument validation", () => {
  it("fails validation-error if targetPath is null", async () => {
    const { client } = fakeClient();
    const executor = buildUploadExecutor({
      factory: {} as never,
      resolveClient: async () => client as never,
    });
    const ctx = makeCtx({});
    // Override the mutable job.targetPath for this scenario.
    const nullifiedCtx: ExecutorCtx = {
      ...ctx,
      job: { ...ctx.job, targetPath: null },
    };
    const result: ExecutorResult = await executor(nullifiedCtx);
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.errorTag).toBe("validation-error");
    }
  });

  it("returns cancelled immediately if signal is already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const { client, uploadFileCalls } = fakeClient();
    const executor = buildUploadExecutor({
      factory: {} as never,
      resolveClient: async () => client as never,
    });
    const result = await executor(makeCtx({ signal: ctl.signal }));
    expect(result.outcome).toBe("cancelled");
    expect(uploadFileCalls).toHaveLength(0);
  });
});
