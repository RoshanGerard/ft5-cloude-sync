// Wire contract for the split authenticate flow — descriptor / completion
// shape assertions.
//
// This file's original assertions covered the stub shape from the
// `wire-fs-sync-service` change. The `implement-datasource-onboarding`
// change reshapes the surface (per design.md Decisions 7 + 9 + 12); the
// new shape's command-level assertions live in
// `authenticate-onboarding.test-d.ts`. This file is now scoped to
// pure-data assertions on `SerializableAuthIntent` / `SerializableAuthCompletion`
// (the descriptor + completion shapes that need to JSON-serialize).
//
// Style: mirrors `commands.test-d.ts` — `expectTypeOf` for structural shape
// assertions. Per-variant `toEqualTypeOf` proves the descriptor carries no
// function properties (`completeWith` / `submit`).

import { describe, expectTypeOf, it } from "vitest";

import type { CredentialsSchema } from "../datasources.js";
import type {
  SerializableAuthCompletion,
  SerializableAuthIntent,
} from "./commands.js";

describe("sync-service authenticate split — wire descriptor", () => {
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

  it("SerializableAuthCompletion is exactly { kind: 'credentials-form', values } — OAuth completions never cross the wire", () => {
    // Per `implement-datasource-onboarding` design.md Decision 7, OAuth
    // completions arrive via the loopback HTTP listener inside the service,
    // not through the renderer-driven `sync:authenticate-complete` request.
    // The wire shape carries ONLY the credentials-form completion.
    expectTypeOf<SerializableAuthCompletion>().toEqualTypeOf<{
      readonly kind: "credentials-form";
      readonly values: Record<string, unknown>;
    }>();
  });
});
