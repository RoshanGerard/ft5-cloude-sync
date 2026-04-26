## ADDED Requirements

### Requirement: Factory exposes `createForAuth` for no-credentials authenticate flows

The engine SHALL expose `ClientFactory.createForAuth(providerId: ProviderId, oauthAppConfig: OAuthAppConfig | null, ctx: EngineContext): DatasourceClient<T>` as a sibling to the existing `ClientFactory.create`. `OAuthAppConfig` SHALL be the typed shape `{ clientId: string; clientSecret: string; redirectUri: string }`. The new factory method exists exclusively for the case where the caller has no `StoredCredentials` yet — that is, the very first call to `engine.authenticate()` for a brand-new datasource — and SHALL NOT consult the credential store.

For OAuth-class providers (`google-drive`, `onedrive`), `oauthAppConfig` SHALL be required (non-null); the strategy SHALL receive it via a typed `PreAuthConfig` constructor slot distinct from `StoredCredentials.meta`. For credentials-form providers (`amazon-s3`), `oauthAppConfig` SHALL be `null`; the strategy SHALL be constructed with no credentials.

The strategy's `doAuthenticateImpl()` SHALL be reachable from a client constructed via `createForAuth` without the existing `readCredsFromStored` empty-field rejection. For OAuth providers, `doAuthenticateImpl()` SHALL read `clientId`, `clientSecret`, and `redirectUri` from the `PreAuthConfig` slot (NOT from `StoredCredentials.meta`) when constructing the authorize URL and the token-exchange request. For credentials-form providers, `doAuthenticateImpl()` SHALL return a `CredentialsFormIntent` whose `submit(values)` validates and persists the supplied values via the engine's existing `decorateIntent` pathway.

Adding a new provider type SHALL continue to require exactly the four touch points named under the existing factory requirement, with one additional concern: the registry entry SHALL declare whether the provider is OAuth-class or credentials-form-class so `createForAuth` can validate the `oauthAppConfig` argument.

#### Scenario: OAuth provider built via createForAuth produces a usable OAuthIntent

- **WHEN** `ClientFactory.createForAuth("google-drive", { clientId: "abc", clientSecret: "def", redirectUri: "http://127.0.0.1:55555/callback" }, { bus, credentialStore })` is called and the returned client's `authenticate()` is invoked
- **THEN** the returned `AuthIntent` has `kind === "oauth"`; the `authorizeUrl` contains `client_id=abc` and `redirect_uri=http%3A%2F%2F127.0.0.1%3A55555%2Fcallback` and the PKCE `code_challenge` parameters; the `completeWith(code)` closure threads the same `code_verifier` and `clientSecret` into the token exchange; no read of `credentialStore` occurs during construction or during `authenticate()`

#### Scenario: Credentials-form provider built via createForAuth produces a CredentialsFormIntent

- **WHEN** `ClientFactory.createForAuth("amazon-s3", null, { bus, credentialStore })` is called and the returned client's `authenticate()` is invoked
- **THEN** the returned `AuthIntent` has `kind === "credentials-form"` and exposes a `submit(values)` closure plus the form-field schema; `submit({ accessKeyId, secretAccessKey, region })` validates the values, performs the existing `HeadBucket` connection check, and on success the engine's `decorateIntent` writes the resulting `AuthResult` via `credentialStore.put(datasourceId, …)` exactly once

#### Scenario: createForAuth rejects a null oauthAppConfig for an OAuth provider

- **WHEN** `ClientFactory.createForAuth("google-drive", null, ctx)` is called (passing null for an OAuth-class provider)
- **THEN** the call throws `DatasourceError` with `tag === "invalid-datasource"`, `retryable === false`, and a message identifying the missing OAuth app config

#### Scenario: createForAuth rejects a non-null oauthAppConfig for a credentials-form provider

- **WHEN** `ClientFactory.createForAuth("amazon-s3", { clientId: "x", clientSecret: "y", redirectUri: "z" }, ctx)` is called (passing OAuth config for a credentials-form provider)
- **THEN** the call throws `DatasourceError` with `tag === "invalid-datasource"`, `retryable === false`, and a message identifying the misuse
