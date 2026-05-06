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
    // The retired single-shot `sync:authenticate` command was removed by
    // `implement-datasource-onboarding` per design.md Decision 9; the
    // three-command authenticate split (`-start` / `-complete` / `-cancel`)
    // is the only path that writes credentials. `sync:get-config` /
    // `sync:set-config` / `sync:delete-credentials` were added by the same
    // change. `downloads:list-active` was added by
    // `add-engine-rename-download` (tasks §3.1/§3.2) — it carries the
    // service-side download registry snapshot the renderer hydrates on
    // first connect. `uploads:list-active` and `sync:cancel-upload` were
    // added by `migrate-upload-orchestration-out-of-engine` (tasks §7.2 +
    // §7.3) — they mirror the download equivalents on the upload side
    // now that orchestration moved out of the engine.
    // migrate-upload-orchestration-out-of-engine §7.4 —
    // `"sync:enqueue-upload"` removed from the union (chunk F).
    type Expected =
      | "sync:enqueue-mirror"
      | "sync:list-jobs"
      | "sync:get-job"
      | "sync:cancel-job"
      | "sync:subscribe-events"
      | "sync:unsubscribe-events"
      | "sync:set-retry-policy"
      | "sync:get-retry-policy"
      | "sync:authenticate-start"
      | "sync:authenticate-complete"
      | "sync:authenticate-cancel"
      | "sync:get-config"
      | "sync:set-config"
      | "sync:delete-credentials"
      | "sync:get-status"
      | "files:list"
      | "files:stat"
      | "files:search"
      | "files:remove"
      | "files:rename"
      | "files:download"
      | "files:upload"
      | "sync:cancel-download"
      | "downloads:list-active"
      | "uploads:list-active"
      | "sync:cancel-upload";
    expectTypeOf<CommandName>().toEqualTypeOf<Expected>();
  });

  it("COMMAND_NAMES tuple contains every CommandName", () => {
    expectTypeOf<(typeof COMMAND_NAMES)[number]>().toEqualTypeOf<CommandName>();
  });

  // migrate-upload-orchestration-out-of-engine §7.4 — the
  // `sync:enqueue-upload` params/result type test was removed in chunk F.
  // The `files:upload` direct RPC's params/result shapes are covered by
  // `packages/ipc-contracts/src/__tests__/files.test-d.ts`.
  it("CommandMap does NOT carry a 'sync:enqueue-upload' key (chunk F removal)", () => {
    type Names = keyof CommandMap;
    type HasEnqueueUpload = "sync:enqueue-upload" extends Names ? true : false;
    expectTypeOf<HasEnqueueUpload>().toEqualTypeOf<false>();
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
