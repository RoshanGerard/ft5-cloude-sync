// Renderer-facing request / response types — contract tests.
//
// Style: HYBRID per the `wire-fs-sync-service` controller decision for task
// 1.1 — flat response shape for happy-path calls (matching `DATASOURCES_*`
// shapes), and a typed `{ jobId } | { error }` / `{ cancelled } | { error }`
// union ONLY for the two fallible calls the spec explicitly names as such
// (`enqueueMirror`, `cancelJob`).

import { describe, expectTypeOf, it } from "vitest";

import type {
  AuthResult,
  DatasourceType,
  AuthIntent,
} from "../fs-datasource-engine.js";
import type {
  JobStatus,
  JobSummary,
  RetryPolicy,
  RetryPolicyScope,
  BackoffStrategy,
  ConflictPolicy,
  NotCancelableErrorShape,
  SyncAlreadyRunningErrorShape,
} from "../sync-service/commands.js";
import type {
  SyncListJobsRequest,
  SyncListJobsResponse,
  SyncGetJobRequest,
  SyncGetJobResponse,
  SyncEnqueueUploadRequest,
  SyncEnqueueUploadResponse,
  SyncEnqueueMirrorRequest,
  SyncEnqueueMirrorResponse,
  SyncCancelJobRequest,
  SyncCancelJobResponse,
  SyncAuthenticateRequest,
  SyncAuthenticateResponse,
  SyncGetStatusRequest,
  SyncGetStatusResponse,
  SyncGetRetryPolicyRequest,
  SyncGetRetryPolicyResponse,
  SyncSetRetryPolicyRequest,
  SyncSetRetryPolicyResponse,
} from "./requests.js";

describe("sync-service-desktop listJobs request/response", () => {
  it("listJobs request carries optional filter", () => {
    expectTypeOf<SyncListJobsRequest>().toEqualTypeOf<{
      readonly filter?: {
        readonly statuses?: ReadonlyArray<JobStatus>;
        readonly datasourceId?: string;
      };
    }>();
  });

  it("listJobs response is a flat shape with jobs + derivedSyncingDatasourceIds", () => {
    expectTypeOf<SyncListJobsResponse>().toEqualTypeOf<{
      readonly jobs: ReadonlyArray<JobSummary>;
      readonly derivedSyncingDatasourceIds: ReadonlyArray<string>;
    }>();
  });
});

describe("sync-service-desktop getJob request/response", () => {
  it("getJob request is { jobId }", () => {
    expectTypeOf<SyncGetJobRequest>().toEqualTypeOf<{
      readonly jobId: string;
    }>();
  });

  it("getJob response is flat { job: JobSummary | null }", () => {
    expectTypeOf<SyncGetJobResponse>().toEqualTypeOf<{
      readonly job: JobSummary | null;
    }>();
  });
});

describe("sync-service-desktop enqueueUpload request/response", () => {
  it("enqueueUpload request has datasourceId, sourcePath, targetPath, conflictPolicy", () => {
    expectTypeOf<SyncEnqueueUploadRequest>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly conflictPolicy: ConflictPolicy;
    }>();
  });

  it("enqueueUpload response is a flat { jobId } (happy-path only)", () => {
    expectTypeOf<SyncEnqueueUploadResponse>().toEqualTypeOf<{
      readonly jobId: string;
    }>();
  });
});

describe("sync-service-desktop enqueueMirror request/response", () => {
  it("enqueueMirror request allows optional conflictPolicy", () => {
    expectTypeOf<SyncEnqueueMirrorRequest>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly sourcePath: string;
      readonly conflictPolicy?: ConflictPolicy;
    }>();
  });

  it("enqueueMirror response is typed union { jobId } | { error }", () => {
    expectTypeOf<SyncEnqueueMirrorResponse>().toEqualTypeOf<
      | { readonly jobId: string }
      | { readonly error: SyncAlreadyRunningErrorShape }
    >();
  });

  it("both variants of the union are assignable", () => {
    const ok: SyncEnqueueMirrorResponse = { jobId: "j-1" };
    const err: SyncEnqueueMirrorResponse = {
      error: {
        tag: "sync-already-running",
        message: "already running",
        details: {
          existingJobId: "j-2",
          datasourceId: "ds-1",
          sourcePath: "/foo",
        },
      },
    };
    expectTypeOf(ok).toMatchTypeOf<SyncEnqueueMirrorResponse>();
    expectTypeOf(err).toMatchTypeOf<SyncEnqueueMirrorResponse>();
  });
});

describe("sync-service-desktop cancelJob request/response", () => {
  it("cancelJob request is { jobId }", () => {
    expectTypeOf<SyncCancelJobRequest>().toEqualTypeOf<{
      readonly jobId: string;
    }>();
  });

  it("cancelJob response is typed union { cancelled } | { error }", () => {
    expectTypeOf<SyncCancelJobResponse>().toEqualTypeOf<
      | { readonly cancelled: true }
      | { readonly error: NotCancelableErrorShape }
    >();
  });
});

describe("sync-service-desktop authenticate request/response", () => {
  it("authenticate request carries datasourceId + type + intent", () => {
    expectTypeOf<SyncAuthenticateRequest>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly type: DatasourceType;
      readonly intent: AuthIntent;
    }>();
  });

  it("authenticate response is a flat { authResult } (happy-path only)", () => {
    expectTypeOf<SyncAuthenticateResponse>().toEqualTypeOf<{
      readonly authResult: AuthResult;
    }>();
  });
});

describe("sync-service-desktop getStatus request/response", () => {
  it("getStatus request is void", () => {
    expectTypeOf<SyncGetStatusRequest>().toEqualTypeOf<void>();
  });

  it("getStatus response has version, serviceUuid, and counts", () => {
    expectTypeOf<SyncGetStatusResponse>().toEqualTypeOf<{
      readonly version: string;
      readonly serviceUuid: string;
      readonly runningJobs: number;
      readonly queuedJobs: number;
      readonly waitingNetworkJobs: number;
    }>();
  });
});

describe("sync-service-desktop getRetryPolicy request/response", () => {
  it("getRetryPolicy request carries scope + optional datasourceId", () => {
    expectTypeOf<SyncGetRetryPolicyRequest>().toEqualTypeOf<{
      readonly scope: RetryPolicyScope;
      readonly datasourceId?: string;
    }>();
  });

  it("getRetryPolicy response is a flat { policy }", () => {
    expectTypeOf<SyncGetRetryPolicyResponse>().toEqualTypeOf<{
      readonly policy: RetryPolicy;
    }>();
  });
});

describe("sync-service-desktop setRetryPolicy request/response", () => {
  it("setRetryPolicy request mirrors the wire command's params", () => {
    expectTypeOf<SyncSetRetryPolicyRequest>().toEqualTypeOf<{
      readonly scope: RetryPolicyScope;
      readonly datasourceId?: string;
      readonly maxAttempts: number;
      readonly backoffMs: number;
      readonly backoffStrategy: BackoffStrategy;
      readonly maxAgeMs?: number;
    }>();
  });

  it("setRetryPolicy response is a flat { policy }", () => {
    expectTypeOf<SyncSetRetryPolicyResponse>().toEqualTypeOf<{
      readonly policy: RetryPolicy;
    }>();
  });
});
