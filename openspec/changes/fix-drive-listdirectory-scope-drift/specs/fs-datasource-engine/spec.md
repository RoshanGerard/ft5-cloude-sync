# Delta: fs-datasource-engine — Drive scope-drift detection

## ADDED Requirements

### Requirement: Google Drive strategy persists the issued OAuth scope on the credential

The `GoogleDriveClient` SHALL capture the issued OAuth scope from every Google token-endpoint response (initial code exchange and refresh-token grant) and persist it to the credential at `authResult.meta.scope` as the verbatim space-separated scope string returned by Google. Concrete strategies SHALL NOT compute scope themselves; they SHALL only forward what Google returns.

For credentials whose `authResult.meta.scope` is unset (legacy credentials predating this requirement), the strategy SHALL on the first call to `status` or `testConnection` per process lifetime call `https://oauth2.googleapis.com/tokeninfo?access_token=<accessToken>`, read the `scope` field from the JSON response, and persist it via the credential-store port. The strategy SHALL NOT call `tokeninfo` again for a credential whose `meta.scope` is set; subsequent reads MUST come from `meta.scope`.

If `tokeninfo` returns a non-2xx response with `error: "invalid_token"` (or equivalent), the strategy SHALL throw `DatasourceError` with `tag: "auth-revoked"` (the existing token-revoked path). If `tokeninfo` fails with a network error, the strategy SHALL throw `DatasourceError` with `tag: "network-error"` and SHALL NOT persist any partial state — the next `status` call retries the backfill.

#### Scenario: New token exchange persists scope

- **WHEN** `exchangeCodeForTokens` receives a token-endpoint response with body `{ "access_token": "...", "refresh_token": "...", "scope": "https://www.googleapis.com/auth/drive openid email", "expires_in": 3599 }`
- **THEN** the resulting `AuthResult.meta.scope` equals `"https://www.googleapis.com/auth/drive openid email"` exactly, and the in-memory `creds.scope` is updated to the same value

#### Scenario: Token refresh persists scope

- **WHEN** `refreshTokenImpl` receives a token-endpoint response that includes a `scope` field
- **THEN** the returned `AuthResult.meta.scope` carries that string and the strategy's in-memory `creds.scope` is updated

#### Scenario: Legacy credential without `meta.scope` is backfilled via tokeninfo on first status

- **GIVEN** a `GoogleDriveClient` constructed from a credential whose `authResult.meta` has `clientId`, `clientSecret`, `redirectUri` but no `scope` field
- **WHEN** `status()` is called for the first time and the injected fetch implementation responds to `https://oauth2.googleapis.com/tokeninfo?access_token=<accessToken>` with `200 { scope: "https://www.googleapis.com/auth/drive.file" }`
- **THEN** the credential-store port's `put` method is called once with a credential whose `authResult.meta.scope === "https://www.googleapis.com/auth/drive.file"`, and on a subsequent `status()` call the `tokeninfo` URL is NOT fetched again

#### Scenario: tokeninfo with invalid_token surfaces auth-revoked

- **GIVEN** a `GoogleDriveClient` whose credential has no `meta.scope`
- **WHEN** `status()` is called and the injected fetch returns `400 { error: "invalid_token" }` from the `tokeninfo` URL
- **THEN** `status()` rejects with a `DatasourceError` whose `tag === "auth-revoked"` and `retryable === false`

#### Scenario: tokeninfo network error surfaces network-error and does not persist

- **GIVEN** a `GoogleDriveClient` whose credential has no `meta.scope`
- **WHEN** `status()` is called and the injected fetch rejects with a system error (`{ code: "ECONNRESET" }`)
- **THEN** `status()` rejects with a `DatasourceError` whose `tag === "network-error"`, the credential-store `put` method is NOT called, and a subsequent `status()` call re-attempts the `tokeninfo` request

### Requirement: Google Drive status / testConnection fail-fast on insufficient scope

When `status()` or `testConnection()` is invoked on a `GoogleDriveClient`, the strategy SHALL — before issuing the existing `about.get` probe — assert that the credential's stored scope grants the engine's mutating operations. The check is satisfied if and only if the space-separated `meta.scope` string contains the literal token `https://www.googleapis.com/auth/drive` (string equality on a space-tokenized split, NOT a prefix match). Other Drive scopes (`drive.file`, `drive.readonly`, `drive.metadata.readonly`, `drive.appdata`) SHALL be considered insufficient on their own, even if combined with each other, because the engine performs `createFile`, `uploadFile`, and `deleteFile` operations.

When the check fails, the strategy SHALL throw a `DatasourceError` constructed with:
- `tag: "auth-revoked"`
- `retryable: false`
- `raw: { kind: "scope-insufficient", requiredScope: "https://www.googleapis.com/auth/drive", actualScope: <verbatim string from meta.scope> }`
- `message`: a human-readable string explaining that Drive permissions are too narrow and the user needs to reconnect with full access

When the check passes, behavior is unchanged: the strategy proceeds to call `about.get({ fields: "storageQuota" })` and returns `"connected"` (for `status`) or resolves (for `testConnection`).

#### Scenario: Sufficient scope passes the check

- **GIVEN** a `GoogleDriveClient` whose `meta.scope === "https://www.googleapis.com/auth/drive"`
- **WHEN** `status()` is called
- **THEN** no `tokeninfo` request is made, the existing `about.get` probe is issued, and the method resolves with `"connected"`

#### Scenario: Sufficient scope embedded in a multi-scope grant passes the check

- **GIVEN** a `GoogleDriveClient` whose `meta.scope === "openid email https://www.googleapis.com/auth/drive profile"`
- **WHEN** `status()` is called
- **THEN** the method resolves with `"connected"` (the full `drive` scope is one of several space-separated tokens)

#### Scenario: drive.file alone is insufficient

- **GIVEN** a `GoogleDriveClient` whose `meta.scope === "https://www.googleapis.com/auth/drive.file"`
- **WHEN** `status()` is called
- **THEN** the method rejects with `DatasourceError` whose `tag === "auth-revoked"`, `retryable === false`, `raw.kind === "scope-insufficient"`, `raw.requiredScope === "https://www.googleapis.com/auth/drive"`, `raw.actualScope === "https://www.googleapis.com/auth/drive.file"`, and `about.get` is NOT called

#### Scenario: drive.readonly is insufficient

- **GIVEN** a `GoogleDriveClient` whose `meta.scope === "https://www.googleapis.com/auth/drive.readonly"`
- **WHEN** `testConnection()` is called
- **THEN** the method rejects with `DatasourceError` whose `tag === "auth-revoked"` and `raw.kind === "scope-insufficient"`

#### Scenario: Combined narrow scopes are still insufficient

- **GIVEN** a `GoogleDriveClient` whose `meta.scope === "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly"`
- **WHEN** `status()` is called
- **THEN** the method rejects with `tag === "auth-revoked"` and `raw.kind === "scope-insufficient"` (no narrow combination satisfies the requirement)

#### Scenario: Authentication-failed event carries scope-insufficient discriminator

- **GIVEN** a `GoogleDriveClient` configured for emission via the engine bus, whose `meta.scope` is `drive.file`
- **WHEN** `status()` is called and rejects with the scope-insufficient `auth-revoked`
- **THEN** the bus observes exactly one `authentication-failed` event whose payload carries the serialized error with `tag: "auth-revoked"` and `raw: { kind: "scope-insufficient", requiredScope, actualScope }`
