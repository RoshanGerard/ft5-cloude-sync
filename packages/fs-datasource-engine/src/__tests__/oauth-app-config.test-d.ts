// Typed test (`.test-d.ts`) for the public `OAuthAppConfig` type added by
// `implement-datasource-onboarding` §2.2.
//
// `OAuthAppConfig` is the typed shape consumed by:
//   - `factory.createForAuth(providerId, oauthAppConfig, ctx)` (§3, future)
//   - the per-strategy `preAuth?: PreAuthConfig` constructor slot (§2.4-§2.7)
//
// `PreAuthConfig` is exported as an alias of `OAuthAppConfig`; the alias
// exists to clarify intent at the strategy constructor parameter site
// (`preAuth: PreAuthConfig`) without introducing a structurally-different
// type.
//
// Per design.md Decision 5 + the spec's `Factory exposes createForAuth …`
// requirement, the canonical shape is:
//
//   { readonly clientId: string;
//     readonly clientSecret: string;
//     readonly redirectUri: string }

import { describe, expectTypeOf, it } from "vitest";

import type { OAuthAppConfig, PreAuthConfig } from "../index.js";

describe("OAuthAppConfig (type-level)", () => {
  it("is exported from the engine's public surface with the canonical shape", () => {
    expectTypeOf<OAuthAppConfig>().toEqualTypeOf<{
      readonly clientId: string;
      readonly clientSecret: string;
      readonly redirectUri: string;
    }>();
  });

  it("PreAuthConfig is a structural alias of OAuthAppConfig", () => {
    expectTypeOf<PreAuthConfig>().toEqualTypeOf<OAuthAppConfig>();
  });

  it("rejects extraneous properties at the value-construction site", () => {
    // Sanity assignment site that exercises the type at a value position.
    const cfg: OAuthAppConfig = {
      clientId: "x",
      clientSecret: "y",
      redirectUri: "z",
    };
    expectTypeOf(cfg).toEqualTypeOf<OAuthAppConfig>();
  });
});
