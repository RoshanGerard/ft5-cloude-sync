// Renderer-facing types for the three-command authenticate split per
// `implement-datasource-onboarding` design.md Decisions 7 + 9 + 12. The
// renderer calls `authenticateStart` to obtain a server-side correlation
// id plus a `kind`-discriminated descriptor. For OAuth, the desktop's
// sync event-bridge consumes `oauth-open-url` to drive `shell.openExternal`
// and the loopback HTTP listener inside the service handles the code
// exchange. For credentials-form, the renderer collects values per the
// returned `formSchema` and posts them via `authenticateComplete`. Both
// flows are cancelable via `authenticateCancel`.
//
// Style: response shapes use the discriminated `{ ok: true, result } |
// { ok: false, error }` union so the renderer can branch on
// `error.tag` (e.g., `service-config-missing` shows the dedicated copy
// in `oauth-form.tsx`). Distinct from the older `enqueueMirror`-style
// hybrid which used `{ jobId } | { error }`.
//
// Co-located with `requests.test-d.ts` rather than under `__tests__/`
// because the package tsconfig excludes `src/**/__tests__/**` from tsc and
// we want tsc -b to typecheck these assertions.

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  CredentialsSchema,
  DatasourceSummary,
  ProviderId,
} from "../datasources.js";
import type {
  SerializableAuthCompletion,
  ServiceConfig,
  SyncAuthenticateCancelError,
  SyncAuthenticateCompleteError,
  SyncAuthenticateStartError,
  SyncDeleteCredentialsError,
  SyncGetConfigError,
  SyncSetConfigError,
} from "../sync-service/commands.js";
import { SYNC_CHANNELS } from "./channels.js";
import type {
  SyncAuthenticateCancelRequest,
  SyncAuthenticateCancelResponse,
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateCompleteResponse,
  SyncAuthenticateStartRequest,
  SyncAuthenticateStartResponse,
  SyncDeleteCredentialsRequest,
  SyncDeleteCredentialsResponse,
  SyncGetConfigRequest,
  SyncGetConfigResponse,
  SyncSetConfigRequest,
  SyncSetConfigResponse,
} from "./requests.js";

describe("sync-service-desktop authenticate-start — renderer contract", () => {
  it("authenticateStart request is { providerId, datasourceId? }", () => {
    expectTypeOf<SyncAuthenticateStartRequest>().toEqualTypeOf<{
      readonly providerId: ProviderId;
      readonly datasourceId?: string;
    }>();
  });

  it("authenticateStart response is the kind-discriminated { ok: true } | { ok: false, error }", () => {
    type Response = SyncAuthenticateStartResponse;

    // The Ok arm is the union of two kind-discriminated result shapes.
    type Ok = Extract<Response, { ok: true }>;
    expectTypeOf<Ok["result"]>().toEqualTypeOf<
      | { readonly correlationId: string; readonly kind: "oauth" }
      | {
          readonly correlationId: string;
          readonly kind: "credentials-form";
          readonly formSchema: CredentialsSchema;
        }
    >();

    type Err = Extract<Response, { ok: false }>;
    expectTypeOf<Err["error"]>().toEqualTypeOf<SyncAuthenticateStartError>();
  });
});

describe("sync-service-desktop authenticate-complete — renderer contract", () => {
  it("authenticateComplete request is { correlationId, completion }", () => {
    expectTypeOf<SyncAuthenticateCompleteRequest>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly completion: SerializableAuthCompletion;
    }>();
  });

  it("authenticateComplete response is the discriminated { ok, result | error } union", () => {
    type Response = SyncAuthenticateCompleteResponse;

    type Ok = Extract<Response, { ok: true }>;
    expectTypeOf<Ok>().toEqualTypeOf<{
      readonly ok: true;
      readonly result: {
        readonly datasourceId: string;
        readonly summary: DatasourceSummary;
      };
    }>();

    type Err = Extract<Response, { ok: false }>;
    expectTypeOf<Err["error"]>().toEqualTypeOf<SyncAuthenticateCompleteError>();
  });
});

describe("sync-service-desktop authenticate-cancel — renderer contract", () => {
  it("authenticateCancel request is { correlationId }", () => {
    expectTypeOf<SyncAuthenticateCancelRequest>().toEqualTypeOf<{
      readonly correlationId: string;
    }>();
  });

  it("authenticateCancel response is the discriminated { ok, result | error } union", () => {
    type Response = SyncAuthenticateCancelResponse;

    type Ok = Extract<Response, { ok: true }>;
    expectTypeOf<Ok>().toEqualTypeOf<{
      readonly ok: true;
      readonly result: { readonly cancelled: boolean };
    }>();

    type Err = Extract<Response, { ok: false }>;
    expectTypeOf<Err["error"]>().toEqualTypeOf<SyncAuthenticateCancelError>();
  });
});

describe("sync-service-desktop config round-trip — renderer contract", () => {
  it("getConfig request is void", () => {
    expectTypeOf<SyncGetConfigRequest>().toEqualTypeOf<void>();
  });

  it("getConfig response carries { config: ServiceConfig } on ok", () => {
    type Ok = Extract<SyncGetConfigResponse, { ok: true }>;
    expectTypeOf<Ok["result"]>().toEqualTypeOf<{
      readonly config: ServiceConfig;
    }>();

    type Err = Extract<SyncGetConfigResponse, { ok: false }>;
    expectTypeOf<Err["error"]>().toEqualTypeOf<SyncGetConfigError>();
  });

  it("setConfig request is { config }", () => {
    expectTypeOf<SyncSetConfigRequest>().toEqualTypeOf<{
      readonly config: ServiceConfig;
    }>();
  });

  it("setConfig response is the discriminated { ok, result | error } union", () => {
    type Ok = Extract<SyncSetConfigResponse, { ok: true }>;
    expectTypeOf<Ok["result"]>().toEqualTypeOf<{ readonly ok: true }>();

    type Err = Extract<SyncSetConfigResponse, { ok: false }>;
    expectTypeOf<Err["error"]>().toEqualTypeOf<SyncSetConfigError>();
  });
});

describe("sync-service-desktop deleteCredentials — renderer contract", () => {
  it("deleteCredentials request is { datasourceId }", () => {
    expectTypeOf<SyncDeleteCredentialsRequest>().toEqualTypeOf<{
      readonly datasourceId: string;
    }>();
  });

  it("deleteCredentials response is the discriminated { ok, result | error } union", () => {
    type Ok = Extract<SyncDeleteCredentialsResponse, { ok: true }>;
    expectTypeOf<Ok["result"]>().toEqualTypeOf<{
      readonly deleted: boolean;
    }>();

    type Err = Extract<SyncDeleteCredentialsResponse, { ok: false }>;
    expectTypeOf<Err["error"]>().toEqualTypeOf<SyncDeleteCredentialsError>();
  });
});

describe("sync-service-desktop SYNC_CHANNELS — implement-datasource-onboarding", () => {
  it("authenticateStart / authenticateComplete / authenticateCancel resolve to wire channels", () => {
    expect(SYNC_CHANNELS.authenticateStart).toBe("sync:authenticate-start");
    expect(SYNC_CHANNELS.authenticateComplete).toBe(
      "sync:authenticate-complete",
    );
    expect(SYNC_CHANNELS.authenticateCancel).toBe("sync:authenticate-cancel");
    expectTypeOf<typeof SYNC_CHANNELS.authenticateStart>().toEqualTypeOf<
      "sync:authenticate-start"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.authenticateComplete>().toEqualTypeOf<
      "sync:authenticate-complete"
    >();
    expectTypeOf<typeof SYNC_CHANNELS.authenticateCancel>().toEqualTypeOf<
      "sync:authenticate-cancel"
    >();
  });

  it("getConfig / setConfig / deleteCredentials resolve to wire channels", () => {
    expect(SYNC_CHANNELS.getConfig).toBe("sync:get-config");
    expect(SYNC_CHANNELS.setConfig).toBe("sync:set-config");
    expect(SYNC_CHANNELS.deleteCredentials).toBe("sync:delete-credentials");
  });

  it("retired single-shot `authenticate` channel is gone", () => {
    type Channels = typeof SYNC_CHANNELS;
    type HasAuthenticate = "authenticate" extends keyof Channels
      ? true
      : false;
    expectTypeOf<HasAuthenticate>().toEqualTypeOf<false>();
    expect(
      Object.prototype.hasOwnProperty.call(SYNC_CHANNELS, "authenticate"),
    ).toBe(false);
  });
});
