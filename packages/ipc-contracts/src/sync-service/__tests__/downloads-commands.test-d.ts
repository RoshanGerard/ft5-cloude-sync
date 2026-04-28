// Type-level assertions for the `downloads:list-active` sync-service command
// added by the `add-engine-rename-download` change (design.md Decision 3 +
// tasks §3.1/§3.2).
//
// The command returns the live snapshot of in-flight download jobs the
// service is tracking in its `DownloadRegistry`. Each `DownloadJob` carries
// the per-job business-domain identity (`downloadJobId`), provenance
// (`datasourceId`, `sourcePath`), placement on disk (`targetPath`), live
// progress (`bytesDownloaded`, `contentLength`), and ordering key
// (`startedAt`). The renderer hydrates its toaster strip on first connect
// from this snapshot.
//
// Response is the standard `{ ok: true, value: ... } | { ok: false, error }`
// envelope used elsewhere in the sync-service surface. Per-command error
// shape is `FilesCommandErrorShape` (the same tagged shape as `files:*`),
// since download lifecycle errors share the same recovery affordances.

import { describe, expectTypeOf, it } from "vitest";

import type {
  COMMAND_NAMES,
  CommandError,
  CommandMap,
  CommandName,
  CommandParams,
  CommandResult,
  DownloadJob,
  DownloadsListActiveRequest,
  DownloadsListActiveResponse,
  FilesCommandErrorShape,
} from "../commands.js";

describe("sync-service downloads:list-active command contract", () => {
  it("CommandMap registers downloads:list-active", () => {
    expectTypeOf<CommandMap["downloads:list-active"]>().not.toBeNever();
  });

  it("CommandName includes downloads:list-active", () => {
    expectTypeOf<"downloads:list-active">().toMatchTypeOf<CommandName>();
  });

  it("COMMAND_NAMES tuple contains downloads:list-active", () => {
    type Names = (typeof COMMAND_NAMES)[number];
    expectTypeOf<"downloads:list-active">().toMatchTypeOf<Names>();
  });

  it("downloads:list-active params are an empty object", () => {
    expectTypeOf<
      CommandParams<"downloads:list-active">
    >().toEqualTypeOf<Record<string, never>>();
  });

  it("DownloadJob carries the documented fields", () => {
    expectTypeOf<DownloadJob>().toEqualTypeOf<{
      readonly downloadJobId: string;
      readonly datasourceId: string;
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly bytesDownloaded: number;
      readonly contentLength: number | null;
      readonly startedAt: number;
    }>();
  });

  it("downloads:list-active result is { jobs: DownloadJob[] }", () => {
    expectTypeOf<CommandResult<"downloads:list-active">>().toEqualTypeOf<{
      readonly jobs: readonly DownloadJob[];
    }>();
  });

  it("downloads:list-active error carries the FilesCommandErrorShape", () => {
    expectTypeOf<
      CommandError<"downloads:list-active">
    >().toEqualTypeOf<FilesCommandErrorShape>();
  });

  it("DownloadsListActiveRequest and DownloadsListActiveResponse alias the envelope shape", () => {
    // Request alias is the params shape (empty object on the wire).
    expectTypeOf<DownloadsListActiveRequest>().toEqualTypeOf<
      Record<string, never>
    >();

    // Response alias is the standard tagged envelope used across the
    // sync-service surface — `{ ok: true, value }` on success,
    // `{ ok: false, error }` on rejection. Discriminating on `ok` picks
    // out the branch shapes.
    type ResponseOk = Extract<DownloadsListActiveResponse, { ok: true }>;
    type ResponseErr = Extract<DownloadsListActiveResponse, { ok: false }>;
    expectTypeOf<ResponseOk["value"]>().toEqualTypeOf<{
      readonly jobs: readonly DownloadJob[];
    }>();
    expectTypeOf<ResponseErr["error"]>().toEqualTypeOf<FilesCommandErrorShape>();
  });
});
