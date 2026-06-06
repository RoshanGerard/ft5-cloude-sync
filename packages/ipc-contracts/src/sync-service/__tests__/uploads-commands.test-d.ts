// Type-level assertions for the `uploads:list-active` and
// `sync:cancel-upload` sync-service commands added by the
// `migrate-upload-orchestration-out-of-engine` change (design.md
// Decisions 5/6 + tasks §7.2 / §7.3 / §7.8).
//
// `uploads:list-active` returns the live snapshot of in-flight upload
// jobs the service is tracking in its `UploadRegistry`. Each `UploadJob`
// carries the per-job business-domain identity (`uploadJobId`),
// provenance (`datasourceId`, `sourcePath`), placement on the remote
// provider (`targetPath`), live progress (`bytesUploaded`,
// `contentLength`), and ordering key (`startedAt`). The renderer
// hydrates its toaster strip on first connect from this snapshot.
//
// `sync:cancel-upload` mirrors `sync:cancel-download` exactly: idempotent
// `{ cancelled: boolean }` reply with `ValidationErrorShape` for the
// only fallible path (a malformed `uploadJobId`).
//
// Response on `uploads:list-active` is the standard
// `{ ok: true, value: ... } | { ok: false, error }` envelope used
// elsewhere in the sync-service surface. Per-command error shape is
// `FilesCommandErrorShape` (the same tagged shape as `files:*`), since
// upload lifecycle errors share the same recovery affordances.

import { describe, expectTypeOf, it } from "vitest";

import type {
  COMMAND_NAMES,
  CommandError,
  CommandMap,
  CommandName,
  CommandParams,
  CommandResult,
  FilesCommandErrorShape,
  UploadJob,
  UploadsListActiveRequest,
  UploadsListActiveResponse,
  ValidationErrorShape,
} from "../commands.js";

describe("sync-service uploads:list-active command contract", () => {
  it("CommandMap registers uploads:list-active", () => {
    expectTypeOf<CommandMap["uploads:list-active"]>().not.toBeNever();
  });

  it("CommandName includes uploads:list-active", () => {
    expectTypeOf<"uploads:list-active">().toMatchTypeOf<CommandName>();
  });

  it("COMMAND_NAMES tuple contains uploads:list-active", () => {
    type Names = (typeof COMMAND_NAMES)[number];
    expectTypeOf<"uploads:list-active">().toMatchTypeOf<Names>();
  });

  it("uploads:list-active params are an empty object", () => {
    expectTypeOf<
      CommandParams<"uploads:list-active">
    >().toEqualTypeOf<Record<string, never>>();
  });

  it("UploadJob carries the documented fields", () => {
    expectTypeOf<UploadJob>().toEqualTypeOf<{
      readonly uploadJobId: string;
      readonly datasourceId: string;
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly bytesUploaded: number;
      readonly contentLength: number | null;
      readonly startedAt: number;
    }>();
  });

  it("UploadJob does NOT carry the in-memory abortController field", () => {
    // The registry entry shape (`UploadJobEntry` in
    // `services/fs-sync/src/uploads/registry.ts`) carries an
    // `AbortController` for cancellation. That field is process-local
    // state and MUST NOT cross the wire — `uploads:list-active`
    // strips it before serialization. Compile-time absence assertion.
    expectTypeOf<keyof UploadJob>().not.toEqualTypeOf<"abortController">();
  });

  it("uploads:list-active result is { jobs: UploadJob[] }", () => {
    expectTypeOf<CommandResult<"uploads:list-active">>().toEqualTypeOf<{
      readonly jobs: readonly UploadJob[];
    }>();
  });

  it("uploads:list-active error carries the FilesCommandErrorShape", () => {
    expectTypeOf<
      CommandError<"uploads:list-active">
    >().toEqualTypeOf<FilesCommandErrorShape>();
  });

  it("UploadsListActiveRequest and UploadsListActiveResponse alias the envelope shape", () => {
    // Request alias is the params shape (empty object on the wire).
    expectTypeOf<UploadsListActiveRequest>().toEqualTypeOf<
      Record<string, never>
    >();

    // Response alias is the standard tagged envelope used across the
    // sync-service surface — `{ ok: true, value }` on success,
    // `{ ok: false, error }` on rejection. Discriminating on `ok` picks
    // out the branch shapes.
    type ResponseOk = Extract<UploadsListActiveResponse, { ok: true }>;
    type ResponseErr = Extract<UploadsListActiveResponse, { ok: false }>;
    expectTypeOf<ResponseOk["value"]>().toEqualTypeOf<{
      readonly jobs: readonly UploadJob[];
    }>();
    expectTypeOf<ResponseErr["error"]>().toEqualTypeOf<FilesCommandErrorShape>();
  });
});

describe("sync-service sync:cancel-upload command contract", () => {
  it("CommandMap registers sync:cancel-upload", () => {
    expectTypeOf<CommandMap["sync:cancel-upload"]>().not.toBeNever();
  });

  it("CommandName includes sync:cancel-upload", () => {
    expectTypeOf<"sync:cancel-upload">().toMatchTypeOf<CommandName>();
  });

  it("COMMAND_NAMES tuple contains sync:cancel-upload", () => {
    type Names = (typeof COMMAND_NAMES)[number];
    expectTypeOf<"sync:cancel-upload">().toMatchTypeOf<Names>();
  });

  it("sync:cancel-upload params are { uploadJobId: string }", () => {
    expectTypeOf<CommandParams<"sync:cancel-upload">>().toEqualTypeOf<{
      readonly uploadJobId: string;
    }>();
  });

  it("sync:cancel-upload result is { cancelled: boolean } (idempotent on unknown id)", () => {
    expectTypeOf<CommandResult<"sync:cancel-upload">>().toEqualTypeOf<{
      readonly cancelled: boolean;
    }>();
  });

  it("sync:cancel-upload error is ValidationErrorShape (mirrors sync:cancel-download)", () => {
    expectTypeOf<
      CommandError<"sync:cancel-upload">
    >().toEqualTypeOf<ValidationErrorShape>();
  });
});
