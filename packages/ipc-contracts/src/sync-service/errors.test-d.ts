import { describe, expectTypeOf, it } from "vitest";

import type {
  SERVICE_ERROR_TAGS,
  ServiceErrorTag,
  SyncAlreadyRunningErrorShape,
  UnknownCommandErrorShape,
} from "./errors.js";

describe("sync-service error contract", () => {
  it("SyncAlreadyRunningErrorShape carries the three required fields", () => {
    expectTypeOf<SyncAlreadyRunningErrorShape>().toEqualTypeOf<{
      readonly tag: "sync-already-running";
      readonly message: string;
      readonly details: {
        readonly existingJobId: string;
        readonly datasourceId: string;
        readonly sourcePath: string;
      };
    }>();
  });

  it("UnknownCommandErrorShape has tag 'unknown-command'", () => {
    expectTypeOf<UnknownCommandErrorShape["tag"]>().toEqualTypeOf<
      "unknown-command"
    >();
  });

  it("ServiceErrorTag covers every tag the service emits", () => {
    type Expected =
      | "sync-already-running"
      | "not-found"
      | "not-cancelable"
      | "unknown-command"
      | "validation-error"
      | "authentication-failed"
      | "parse-error"
      | "internal-error";
    expectTypeOf<ServiceErrorTag>().toEqualTypeOf<Expected>();
  });

  it("SERVICE_ERROR_TAGS tuple contains every ServiceErrorTag", () => {
    expectTypeOf<(typeof SERVICE_ERROR_TAGS)[number]>().toEqualTypeOf<
      ServiceErrorTag
    >();
  });
});
