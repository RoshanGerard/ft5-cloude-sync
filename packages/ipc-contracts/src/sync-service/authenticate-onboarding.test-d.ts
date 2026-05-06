// Wire contract for the `implement-datasource-onboarding` change.
//
// The `wire-fs-sync-service` change shipped a stub authenticate-split. The
// follow-up reshapes the wire surface into its real shape:
//
//   * `sync:authenticate-start` returns a result discriminated on `kind`
//     (`oauth` | `credentials-form`) — no `intent` / closures on the wire.
//     Errors include `service-config-missing` (with `path`/`providerId`),
//     `unknown-provider`, and `engine-error`. The `not-implemented` stub tag
//     is removed.
//   * `sync:authenticate-complete` accepts only `kind: "credentials-form"`
//     completions on the wire — OAuth completions land via the loopback
//     callback inside the service. Errors are `correlation-expired`,
//     `intent-kind-mismatch`, `engine-error`. The `not-implemented` stub tag
//     is removed.
//   * `sync:authenticate-cancel` is added for symmetric idempotent cancel.
//   * `sync:get-config` / `sync:set-config` expose the per-provider OAuth
//     app config to the desktop (round-tripped from the renderer for a
//     future settings UI).
//   * `sync:delete-credentials` is the symmetric counterpart of authenticate
//     (best-effort credential cleanup on datasource removal).
//   * The retired single-shot `sync:authenticate` command is GONE.
//
// See `openspec/changes/implement-datasource-onboarding/design.md`
// Decisions 7 + 9 + 12 and the modified `fs-sync-service` "IPC command
// surface" requirement.

import { describe, expectTypeOf, it } from "vitest";

import type { ProviderId } from "../datasources.js";
import type { DatasourceSummary } from "../datasources.js";
import type {
  CommandError,
  CommandMap,
  CommandName,
  CommandParams,
  CommandResult,
  ServiceConfig,
  SyncAuthenticateCancelError,
  SyncAuthenticateCompleteError,
  SyncAuthenticateStartError,
  SyncDeleteCredentialsError,
  SyncGetConfigError,
  SyncSetConfigError,
} from "./commands.js";

describe("sync:authenticate-start — implement-datasource-onboarding shape", () => {
  it("params are { providerId: ProviderId, datasourceId?: string }", () => {
    expectTypeOf<CommandParams<"sync:authenticate-start">>().toEqualTypeOf<{
      readonly providerId: ProviderId;
      readonly datasourceId?: string;
    }>();
  });

  it("result is the kind-discriminated union (oauth | credentials-form)", () => {
    type Result = CommandResult<"sync:authenticate-start">;

    type OAuthArm = Extract<Result, { kind: "oauth" }>;
    expectTypeOf<OAuthArm>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly kind: "oauth";
    }>();

    type FormArm = Extract<Result, { kind: "credentials-form" }>;
    expectTypeOf<FormArm["correlationId"]>().toEqualTypeOf<string>();
    expectTypeOf<FormArm["kind"]>().toEqualTypeOf<"credentials-form">();
    // formSchema is the renderer-discriminator string the credentials-form
    // component branches on. Today the engine's `CredentialsFormIntent.schema`
    // is the same `CredentialsSchema` literal union.
    expectTypeOf<FormArm["formSchema"]>().not.toBeNever();
  });

  it("error union exposes service-config-missing with { path, providerId }", () => {
    type Err = SyncAuthenticateStartError;
    type ConfigMissing = Extract<Err, { tag: "service-config-missing" }>;
    expectTypeOf<ConfigMissing>().not.toBeNever();
    expectTypeOf<ConfigMissing["path"]>().toEqualTypeOf<string>();
    expectTypeOf<ConfigMissing["providerId"]>().toEqualTypeOf<string>();
  });

  it("error union exposes unknown-provider with { providerId }", () => {
    type Err = SyncAuthenticateStartError;
    type UnknownProvider = Extract<Err, { tag: "unknown-provider" }>;
    expectTypeOf<UnknownProvider>().not.toBeNever();
    expectTypeOf<UnknownProvider["providerId"]>().toEqualTypeOf<string>();
  });

  it("error union exposes engine-error with { message }", () => {
    type Err = SyncAuthenticateStartError;
    type EngineError = Extract<Err, { tag: "engine-error" }>;
    expectTypeOf<EngineError>().not.toBeNever();
    expectTypeOf<EngineError["message"]>().toEqualTypeOf<string>();
  });

  it("error union does NOT contain the retired not-implemented variant", () => {
    type Err = SyncAuthenticateStartError;
    type NotImplemented = Extract<Err, { tag: "not-implemented" }>;
    expectTypeOf<NotImplemented>().toBeNever();
  });

  it("CommandError<sync:authenticate-start> is the SyncAuthenticateStartError union", () => {
    expectTypeOf<
      CommandError<"sync:authenticate-start">
    >().toEqualTypeOf<SyncAuthenticateStartError>();
  });
});

describe("sync:authenticate-complete — implement-datasource-onboarding shape", () => {
  it("params are { correlationId, completion: { kind: 'credentials-form', values } }", () => {
    expectTypeOf<CommandParams<"sync:authenticate-complete">>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly completion: {
        readonly kind: "credentials-form";
        readonly values: Record<string, unknown>;
      };
    }>();
  });

  it("result is { datasourceId, summary }", () => {
    expectTypeOf<
      CommandResult<"sync:authenticate-complete">
    >().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly summary: DatasourceSummary;
    }>();
  });

  it("error union has correlation-expired with { correlationId }", () => {
    type Err = SyncAuthenticateCompleteError;
    type Expired = Extract<Err, { tag: "correlation-expired" }>;
    expectTypeOf<Expired>().not.toBeNever();
    expectTypeOf<Expired["correlationId"]>().toEqualTypeOf<string>();
  });

  it("error union has intent-kind-mismatch with { expected, actual }", () => {
    type Err = SyncAuthenticateCompleteError;
    type Mismatch = Extract<Err, { tag: "intent-kind-mismatch" }>;
    expectTypeOf<Mismatch>().not.toBeNever();
    expectTypeOf<Mismatch["expected"]>().toEqualTypeOf<
      "oauth" | "credentials-form"
    >();
    expectTypeOf<Mismatch["actual"]>().toEqualTypeOf<
      "oauth" | "credentials-form"
    >();
  });

  it("error union has engine-error with { message }", () => {
    type Err = SyncAuthenticateCompleteError;
    type EngineError = Extract<Err, { tag: "engine-error" }>;
    expectTypeOf<EngineError>().not.toBeNever();
    expectTypeOf<EngineError["message"]>().toEqualTypeOf<string>();
  });

  it("error union does NOT contain the retired not-implemented variant", () => {
    type Err = SyncAuthenticateCompleteError;
    type NotImplemented = Extract<Err, { tag: "not-implemented" }>;
    expectTypeOf<NotImplemented>().toBeNever();
  });
});

describe("sync:authenticate-cancel — implement-datasource-onboarding shape", () => {
  it("params are { correlationId }", () => {
    expectTypeOf<CommandParams<"sync:authenticate-cancel">>().toEqualTypeOf<{
      readonly correlationId: string;
    }>();
  });

  it("result is { cancelled: boolean }", () => {
    expectTypeOf<CommandResult<"sync:authenticate-cancel">>().toEqualTypeOf<{
      readonly cancelled: boolean;
    }>();
  });

  it("error union has correlation-not-found with { correlationId }", () => {
    type Err = SyncAuthenticateCancelError;
    type NotFound = Extract<Err, { tag: "correlation-not-found" }>;
    expectTypeOf<NotFound>().not.toBeNever();
    expectTypeOf<NotFound["correlationId"]>().toEqualTypeOf<string>();
  });

  it("CommandError<sync:authenticate-cancel> is the SyncAuthenticateCancelError union", () => {
    expectTypeOf<
      CommandError<"sync:authenticate-cancel">
    >().toEqualTypeOf<SyncAuthenticateCancelError>();
  });
});

describe("sync:get-config / sync:set-config — config round-trip", () => {
  it("ServiceConfig has { schemaVersion: 1, providers: Record<ProviderId, { clientId, clientSecret }> }", () => {
    expectTypeOf<ServiceConfig>().toEqualTypeOf<{
      readonly schemaVersion: 1;
      readonly providers: Readonly<
        Partial<
          Record<
            ProviderId,
            { readonly clientId: string; readonly clientSecret: string }
          >
        >
      >;
    }>();
  });

  it("sync:get-config has empty params", () => {
    expectTypeOf<CommandParams<"sync:get-config">>().toEqualTypeOf<
      Record<string, never>
    >();
  });

  it("sync:get-config result is { config: ServiceConfig }", () => {
    expectTypeOf<CommandResult<"sync:get-config">>().toEqualTypeOf<{
      readonly config: ServiceConfig;
    }>();
  });

  it("sync:get-config error includes io-error", () => {
    type Err = SyncGetConfigError;
    type IoErr = Extract<Err, { tag: "io-error" }>;
    expectTypeOf<IoErr>().not.toBeNever();
    expectTypeOf<IoErr["message"]>().toEqualTypeOf<string>();
  });

  it("sync:set-config params are { config: ServiceConfig }", () => {
    expectTypeOf<CommandParams<"sync:set-config">>().toEqualTypeOf<{
      readonly config: ServiceConfig;
    }>();
  });

  it("sync:set-config result is { ok: true }", () => {
    expectTypeOf<CommandResult<"sync:set-config">>().toEqualTypeOf<{
      readonly ok: true;
    }>();
  });

  it("sync:set-config error includes io-error", () => {
    type Err = SyncSetConfigError;
    type IoErr = Extract<Err, { tag: "io-error" }>;
    expectTypeOf<IoErr>().not.toBeNever();
    expectTypeOf<IoErr["message"]>().toEqualTypeOf<string>();
  });
});

describe("sync:delete-credentials — symmetric counterpart of authenticate", () => {
  it("params are { datasourceId }", () => {
    expectTypeOf<CommandParams<"sync:delete-credentials">>().toEqualTypeOf<{
      readonly datasourceId: string;
    }>();
  });

  it("result is { deleted: boolean }", () => {
    expectTypeOf<CommandResult<"sync:delete-credentials">>().toEqualTypeOf<{
      readonly deleted: boolean;
    }>();
  });

  it("error union has io-error with { message }", () => {
    type Err = SyncDeleteCredentialsError;
    type IoErr = Extract<Err, { tag: "io-error" }>;
    expectTypeOf<IoErr>().not.toBeNever();
    expectTypeOf<IoErr["message"]>().toEqualTypeOf<string>();
  });
});

describe("CommandMap exhaustive — new commands present, retired commands gone", () => {
  it("CommandName is exactly the documented set (incl. new commands, no retired sync:authenticate)", () => {
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

  it("the retired single-shot sync:authenticate is absent from CommandMap", () => {
    type HasOldAuthenticate = "sync:authenticate" extends keyof CommandMap
      ? true
      : false;
    expectTypeOf<HasOldAuthenticate>().toEqualTypeOf<false>();
  });

  it("all new commands resolve to entries in CommandMap (not phantom keys)", () => {
    expectTypeOf<CommandMap["sync:authenticate-start"]>().not.toBeNever();
    expectTypeOf<CommandMap["sync:authenticate-complete"]>().not.toBeNever();
    expectTypeOf<CommandMap["sync:authenticate-cancel"]>().not.toBeNever();
    expectTypeOf<CommandMap["sync:get-config"]>().not.toBeNever();
    expectTypeOf<CommandMap["sync:set-config"]>().not.toBeNever();
    expectTypeOf<CommandMap["sync:delete-credentials"]>().not.toBeNever();
  });
});
