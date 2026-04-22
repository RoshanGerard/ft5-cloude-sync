// Wire contract for the split authenticate flow (design.md Decision 10).
//
// The original `sync:authenticate` command shipped an `AuthIntent` over the
// wire, which carries closures (`completeWith` / `submit`) that cannot survive
// JSON serialization. The redesign splits the single command into two
// commands bound by a service-side correlation id, and replaces `AuthIntent`
// on the wire with a pure-data descriptor `SerializableAuthIntent`.
//
// These tests assert the NEW types exist alongside the old ones. The old
// `AuthenticateCommand` remains in place until the atomic removal in tasks
// 5.A.14 / 5.A.15.
//
// Style: mirrors `commands.test-d.ts` — `expectTypeOf` for structural shape
// assertions. Per-variant `toEqualTypeOf` assertions on each extracted
// discriminated variant are how we prove the descriptor carries no function
// properties: `toEqualTypeOf` is exact, so an extra `completeWith` / `submit`
// field would fail the match.

import { describe, expectTypeOf, it } from "vitest";

import type {
  AuthResult,
  DatasourceType,
} from "../fs-datasource-engine.js";
import type { CredentialsSchema } from "../datasources.js";
import type {
  CommandError,
  CommandMap,
  CommandName,
  CommandParams,
  CommandResult,
  SerializableAuthCompletion,
  SerializableAuthIntent,
  ValidationErrorShape,
} from "./commands.js";

describe("sync-service authenticate split — wire contract", () => {
  it("SerializableAuthIntent has two pure-data variants", () => {
    expectTypeOf<SerializableAuthIntent>().toEqualTypeOf<
      | { readonly kind: "oauth"; readonly authorizeUrl: string }
      | { readonly kind: "credentials-form"; readonly schema: CredentialsSchema }
    >();
  });

  it("SerializableAuthIntent oauth variant is exactly { kind, authorizeUrl } — no completeWith", () => {
    expectTypeOf<
      Extract<SerializableAuthIntent, { kind: "oauth" }>
    >().toEqualTypeOf<{
      readonly kind: "oauth";
      readonly authorizeUrl: string;
    }>();
  });

  it("SerializableAuthIntent credentials-form variant is exactly { kind, schema } — no submit", () => {
    expectTypeOf<
      Extract<SerializableAuthIntent, { kind: "credentials-form" }>
    >().toEqualTypeOf<{
      readonly kind: "credentials-form";
      readonly schema: CredentialsSchema;
    }>();
  });

  it("SerializableAuthCompletion has two pure-data variants", () => {
    expectTypeOf<SerializableAuthCompletion>().toEqualTypeOf<
      | { readonly kind: "oauth"; readonly code: string }
      | {
          readonly kind: "credentials-form";
          readonly values: Record<string, unknown>;
        }
    >();
  });

  it("SerializableAuthCompletion oauth variant is exactly { kind, code } — no function", () => {
    expectTypeOf<
      Extract<SerializableAuthCompletion, { kind: "oauth" }>
    >().toEqualTypeOf<{
      readonly kind: "oauth";
      readonly code: string;
    }>();
  });

  it("SerializableAuthCompletion credentials-form variant is exactly { kind, values } — no function", () => {
    expectTypeOf<
      Extract<SerializableAuthCompletion, { kind: "credentials-form" }>
    >().toEqualTypeOf<{
      readonly kind: "credentials-form";
      readonly values: Record<string, unknown>;
    }>();
  });

  it("sync:authenticate-start params are { datasourceId, type }", () => {
    expectTypeOf<CommandParams<"sync:authenticate-start">>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly type: DatasourceType;
    }>();
  });

  it("sync:authenticate-start result is { correlationId, intent }", () => {
    expectTypeOf<CommandResult<"sync:authenticate-start">>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly intent: SerializableAuthIntent;
    }>();
  });

  it("sync:authenticate-start error covers validation + authentication-failed", () => {
    type ErrU = CommandError<"sync:authenticate-start">;
    expectTypeOf<ValidationErrorShape>().toMatchTypeOf<ErrU>();
    // authentication-failed is inlined (matches the existing AuthenticateCommand style)
    expectTypeOf<{
      readonly tag: "authentication-failed";
      readonly message: string;
      readonly details: unknown;
    }>().toMatchTypeOf<ErrU>();
  });

  it("sync:authenticate-complete params are { correlationId, completion }", () => {
    expectTypeOf<CommandParams<"sync:authenticate-complete">>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly completion: SerializableAuthCompletion;
    }>();
  });

  it("sync:authenticate-complete result is { authResult }", () => {
    expectTypeOf<CommandResult<"sync:authenticate-complete">>().toEqualTypeOf<{
      readonly authResult: AuthResult;
    }>();
  });

  it("sync:authenticate-complete error includes correlation-expired and correlation-kind-mismatch", () => {
    type ErrU = CommandError<"sync:authenticate-complete">;
    expectTypeOf<ValidationErrorShape>().toMatchTypeOf<ErrU>();
    expectTypeOf<{
      readonly tag: "correlation-expired";
      readonly message: string;
    }>().toMatchTypeOf<ErrU>();
    expectTypeOf<{
      readonly tag: "correlation-kind-mismatch";
      readonly message: string;
      readonly details: {
        readonly expectedKind: "oauth" | "credentials-form";
        readonly receivedKind: "oauth" | "credentials-form";
      };
    }>().toMatchTypeOf<ErrU>();
  });

  it("CommandMap includes both new command keys", () => {
    expectTypeOf<"sync:authenticate-start">().toMatchTypeOf<CommandName>();
    expectTypeOf<"sync:authenticate-complete">().toMatchTypeOf<CommandName>();
    // Defensive: ensure they resolve to entries in the map, not phantom keys.
    expectTypeOf<CommandMap["sync:authenticate-start"]>().not.toBeNever();
    expectTypeOf<CommandMap["sync:authenticate-complete"]>().not.toBeNever();
  });
});
