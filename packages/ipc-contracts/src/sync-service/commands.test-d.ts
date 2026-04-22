import { describe, expectTypeOf, it } from "vitest";

import type {
  COMMAND_NAMES,
  CommandError,
  CommandMap,
  CommandName,
  CommandParams,
  CommandResult,
  ConflictPolicy,
  JobKind,
  JobStatus,
  NotCancelableErrorShape,
  NotFoundErrorShape,
  SyncAlreadyRunningErrorShape,
} from "./commands.js";

describe("sync-service command contract", () => {
  it("enumerates every command the spec requires", () => {
    // If a command is added to the spec, add it here too and to CommandMap.
    type Expected =
      | "sync:enqueue-upload"
      | "sync:enqueue-mirror"
      | "sync:list-jobs"
      | "sync:get-job"
      | "sync:cancel-job"
      | "sync:subscribe-events"
      | "sync:unsubscribe-events"
      | "sync:set-retry-policy"
      | "sync:get-retry-policy"
      | "sync:authenticate"
      | "sync:authenticate-start"
      | "sync:authenticate-complete"
      | "sync:get-status";
    expectTypeOf<CommandName>().toEqualTypeOf<Expected>();
  });

  it("COMMAND_NAMES tuple contains every CommandName", () => {
    expectTypeOf<(typeof COMMAND_NAMES)[number]>().toEqualTypeOf<CommandName>();
  });

  it("sync:enqueue-upload params and result match the spec", () => {
    expectTypeOf<CommandParams<"sync:enqueue-upload">>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly conflictPolicy: ConflictPolicy;
    }>();
    expectTypeOf<CommandResult<"sync:enqueue-upload">>().toEqualTypeOf<{
      readonly jobId: string;
    }>();
  });

  it("sync:enqueue-mirror error includes SyncAlreadyRunningErrorShape", () => {
    type ErrU = CommandError<"sync:enqueue-mirror">;
    expectTypeOf<SyncAlreadyRunningErrorShape>().toMatchTypeOf<ErrU>();
  });

  it("sync:cancel-job error distinguishes not-found vs not-cancelable", () => {
    type ErrU = CommandError<"sync:cancel-job">;
    expectTypeOf<NotFoundErrorShape>().toMatchTypeOf<ErrU>();
    expectTypeOf<NotCancelableErrorShape>().toMatchTypeOf<ErrU>();
  });

  it("sync:get-status result carries the documented fields", () => {
    expectTypeOf<CommandResult<"sync:get-status">>().toEqualTypeOf<{
      readonly version: string;
      readonly serviceUuid: string;
      readonly runningJobs: number;
      readonly queuedJobs: number;
      readonly waitingNetworkJobs: number;
      readonly monitorConnected: boolean;
    }>();
  });

  it("JobKind is 'upload' | 'sync'", () => {
    expectTypeOf<JobKind>().toEqualTypeOf<"upload" | "sync">();
  });

  it("JobStatus covers every row lifecycle value", () => {
    expectTypeOf<JobStatus>().toEqualTypeOf<
      | "queued"
      | "running"
      | "waiting-network"
      | "completed"
      | "failed"
      | "cancelled"
    >();
  });

  it("CommandMap key set equals CommandName", () => {
    expectTypeOf<keyof CommandMap>().toEqualTypeOf<CommandName>();
  });
});
