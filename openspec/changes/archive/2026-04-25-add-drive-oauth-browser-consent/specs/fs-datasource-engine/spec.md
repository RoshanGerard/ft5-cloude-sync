## ADDED Requirements

### Requirement: Google Drive OAuth flow uses PKCE (RFC 7636, S256)

The Google Drive strategy's `doAuthenticateImpl` SHALL generate a fresh `code_verifier` per consent attempt (48 random bytes encoded as base64url, yielding 64 URL-safe characters) and include `code_challenge=base64url(SHA256(verifier))` with `code_challenge_method=S256` in the authorize URL. The `completeWith(code)` closure returned by the intent SHALL pass the same `code_verifier` as a `code_verifier` form field on the token-exchange POST to `https://oauth2.googleapis.com/token`. The verifier SHALL be held only as captured closure state for the lifetime of the intent; it SHALL NOT be persisted via `CredentialStore`, logged, emitted on any event, or returned in the `AuthResult`.

#### Scenario: Authorize URL carries S256 challenge parameters

- **WHEN** a test invokes `GoogleDriveClient.authenticate()` and parses the resulting `authorizeUrl`
- **THEN** the URL's query string contains `code_challenge_method=S256` and a `code_challenge` value that is exactly `base64url(SHA256(code_verifier))` where `code_verifier` is the verifier captured inside the returned `completeWith` closure — the 43-character base64url-encoded SHA256 output, with no padding

#### Scenario: Verifier threads into the token exchange

- **WHEN** a test's injected `fetchImpl` intercepts the POST to `https://oauth2.googleapis.com/token` triggered by `intent.completeWith("fake-code")`
- **THEN** the request body (parsed as `application/x-www-form-urlencoded`) contains exactly one `code_verifier` field whose value matches the verifier embedded in the authorize URL's `code_challenge`

#### Scenario: Fresh verifier per call

- **WHEN** two consecutive `authenticate()` calls on the same `GoogleDriveClient` instance return two intents
- **THEN** the two intents' authorize URLs carry two different `code_challenge` values, derived from two different verifiers

#### Scenario: Verifier is never stored or logged

- **WHEN** a grep scan examines `packages/fs-datasource-engine/src/strategies/googledrive-client.ts` and the project's credentials file after a successful consent
- **THEN** no `code_verifier` value is present in the persisted `StoredCredentials` (neither at the top level nor under `authResult.meta`), no `console.log` / `emit` / `trace` call references the verifier, and the only code path that reads the verifier is the `completeWith` closure's call to `exchangeCodeForTokens`
