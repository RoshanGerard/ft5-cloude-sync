// Auth-flow types shared across the engine package.
//
// `OAuthAppConfig` is the typed shape of an OAuth application registration
// (clientId / Secret / redirectUri are vendor-side identifiers obtained by
// registering FT5 in the provider's developer console — distinct from
// per-user tokens which live in `StoredCredentials`). It is consumed by:
//
//   - `factory.createForAuth(providerId, oauthAppConfig, ctx)` (the
//     no-credentials authenticate factory; lands in implement-datasource-
//     onboarding §3) for OAuth-class providers.
//   - the per-strategy `preAuth?: PreAuthConfig` constructor slot (§2)
//     where each OAuth strategy reads `clientId` / `clientSecret` /
//     `redirectUri` at `doAuthenticateImpl()` time when constructing the
//     authorize URL and the token-exchange request.
//
// `PreAuthConfig` is a structural alias of `OAuthAppConfig`. The two names
// intentionally point at the same shape; `PreAuthConfig` is preferred at
// the strategy-constructor parameter site (`preAuth: PreAuthConfig`) so
// the role at the call site is self-describing, while `OAuthAppConfig`
// is preferred at the factory / config-store boundary where the value is
// produced.
//
// See `openspec/changes/implement-datasource-onboarding/design.md`
// Decision 5 + Decision 13 (Q4) for the architectural framing.

/**
 * OAuth application registration config. Same shape across every OAuth-
 * class provider; OneDrive's additional `tenantId` lives on the strategy's
 * own credentials struct, NOT here, because tenant selection is a
 * deployment-time concern rather than a vendor-app-registration concern.
 */
export type OAuthAppConfig = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
};

/**
 * Alias used in strategy constructor parameters to clarify intent. Same
 * shape as `OAuthAppConfig`; the name signals that the value seeded the
 * client BEFORE any user-side authentication has happened.
 */
export type PreAuthConfig = OAuthAppConfig;
