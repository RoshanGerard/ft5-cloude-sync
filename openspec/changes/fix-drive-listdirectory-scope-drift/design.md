# Design: scope-drift detection for Google Drive

## Context

`GoogleDriveClient` requests OAuth scope `https://www.googleapis.com/auth/drive` (full read/write across all the user's Drive content). The actual scope *issued* by Google is determined by the consent dialog at the time the user first authorized the app — and Google's token endpoint does **not** widen an existing refresh token when the requested scope changes in source. If a user previously consented under `drive.file` (only files the app creates), every subsequent token exchange returns a token still bound to `drive.file`. The engine has no way today to notice this.

Symptoms of the bug:

- `listDirectory({ kind: "path", path: "/" })` returns only files the app uploaded. Pre-existing user content is invisible.
- `getMetadata` succeeds for app-created files and 404s for everything else.
- `about.get({ fields: "storageQuota" })` works under any read scope (including `drive.metadata.readonly`), so today's `doStatusImpl` reports `connected` and the UI never enters `auth-revoked`.

The dev credential at `$HOME/ft5/sync_app/dev/credentials.json` is OAuth-issued (access token has the `ya29.` prefix; no `private_key` / `type: "service_account"` field). The credential schema is:

```json
{
  "schemaVersion": 1,
  "credentials": {
    "<datasourceId>": {
      "providerId": "google-drive",
      "authResult": {
        "accessToken": "ya29...",
        "refreshToken": "...",
        "meta": { "clientId": "...", "clientSecret": "...", "redirectUri": "..." }
      }
    }
  }
}
```

`AuthResult.meta` is a `Record<string, unknown>` — adding a `scope` field is additive and requires no IPC contract update.

## Goals / Non-Goals

**Goals:**
- Detect, at connect time, that the issued OAuth scope is insufficient for the engine's required operations.
- Persist the issued scope on the credential so the check is cheap (no extra Drive round-trip) on every status call after the first.
- Surface scope drift through the existing `auth-revoked` error path with a structured `raw` discriminator that downstream consumers (and a future tailored UI variant) can branch on.
- Cover legacy credentials that pre-date this change with a one-time backfill via `tokeninfo`.

**Non-Goals:**
- Re-consent UX. Opening the system browser, hosting the loopback redirect, and exchanging the new code for a wider-scoped refresh token live in `add-drive-oauth-browser-consent`. Until that change lands, a user hitting `auth-revoked: scope-insufficient` is told to re-consent but the Reconnect button does not yet drive the flow.
- Renderer message tailoring. The existing `AuthRevokedState` shows a generic copy. Branching it on `raw.kind === "scope-insufficient"` is paired with the consent flow, when there is an actionable remedy on the other side of the button.
- Pagination. `listDirectory` not following `nextPageToken` is tracked as `add-engine-listdirectory-pagination`. Empty listings due to scope drift are NOT a pagination problem; the detector here is the right diagnosis path.
- Shared drives (`includeItemsFromAllDrives: true`). Orthogonal to scope drift — owns its own change.
- Service-account credentials. The dev credential is confirmed OAuth-issued; service-account support, if ever needed, is its own change.

## Decisions

### Decision 1 — Sufficiency rule: issued scope set MUST include the full `drive` scope

The engine performs mutations: `createFile`, `uploadFile`, `deleteFile`. The minimum scope that grants those across the user's whole Drive is `https://www.googleapis.com/auth/drive`. Narrower variants are insufficient:

| Scope                                                | Sufficient? | Why                                                           |
|------------------------------------------------------|:-----------:|---------------------------------------------------------------|
| `https://www.googleapis.com/auth/drive`              | ✅          | Full read/write on all content the user owns / has access to. |
| `https://www.googleapis.com/auth/drive.file`         | ❌          | Only files created or opened by this app.                     |
| `https://www.googleapis.com/auth/drive.readonly`     | ❌          | No mutations; uploads / deletes will fail.                    |
| `https://www.googleapis.com/auth/drive.metadata.readonly` | ❌      | No content access at all.                                     |
| `https://www.googleapis.com/auth/drive.appdata`      | ❌          | App-private storage only.                                     |

Google's `scope` claim is a **space-separated list of scope URIs**. The check is: `actualScopes.includes("https://www.googleapis.com/auth/drive")` (string equality, not prefix). A token issued with `drive` plus other scopes is still sufficient; a token issued with only `drive.file` is not.

**Alternative considered**: heuristic detection (run a `files.list` and infer drift from "0 files at root"). Rejected: indistinguishable from a genuinely empty Drive, and a heuristic mis-call is worse than no detection.

### Decision 2 — Scope is persisted on the credential at `authResult.meta.scope`

`parseTokenResponse` already writes `meta.clientId / clientSecret / redirectUri`. Adding `scope` follows the same pattern. The token-endpoint response carries `scope: "<space-separated URIs>"`; we copy it verbatim. This applies to both `exchangeCodeForTokens` (initial consent) and `refreshTokenImpl` (refresh).

**Alternative considered**: cache the scope in-memory only. Rejected: a process restart would re-call `tokeninfo` for every legacy credential. Persisting is one extra string per credential and turns the check into a pure local string compare.

### Decision 3 — Legacy credentials get a one-time `tokeninfo` backfill

For credentials that exist before this change ships, `meta.scope` is absent. On the first `doStatusImpl` after upgrade, the engine calls `https://oauth2.googleapis.com/tokeninfo?access_token=<accessToken>` and reads `scope` from the JSON response. The strategy stores the resolved scope back via the credential-store port (read-modify-write through `ctx.credentialStore.get(...)` then `ctx.credentialStore.put(...)`; the `CredentialStore` interface exposes `get/put/delete`, not a separate `update`) and then proceeds with the sufficiency check.

**Backfill failure modes:**
- `tokeninfo` returns 400 with `error: "invalid_token"` → token is dead → throw `auth-revoked` (existing behavior, no scope info attached).
- Network error → throw `network-error`. Don't persist anything; backfill retries on the next status call.
- 200 OK with `scope` field → persist and continue.

`tokeninfo` is **never** called once `meta.scope` is set. A re-consent (which fires through `parseTokenResponse`) overwrites the stored scope.

**Alternative considered**: backfill lazily inside `listDirectory` instead of `doStatusImpl`. Rejected: status is the natural "is this datasource ok?" probe; failing fast there means the file-explorer never tries to render a listing that would silently truncate.

### Decision 4 — Sufficiency check runs in `doStatusImpl` and `doTestConnectionImpl`

Both call sites already exist, both already do `about.get`. The new check runs **before** `about.get` (no point hitting Drive if we already know the scope is wrong). Both methods get the same prelude:

```ts
private async checkScopeSufficiency(): Promise<void> {
  const stored = this.creds.scope; // populated from meta.scope at construction
  let actual = stored;
  if (!actual) {
    actual = await this.fetchTokenScope();
    await this.persistScope(actual);
  }
  if (!isScopeSufficient(actual)) {
    throw new DatasourceError({
      tag: "auth-revoked",
      retryable: false,
      raw: { kind: "scope-insufficient", requiredScope: OAUTH_SCOPE, actualScope: actual },
      message: "Drive permissions are too narrow — reconnect with full access to see your existing files.",
      // ...
    });
  }
}
```

`fetchTokenScope` issues the `tokeninfo` GET; `isScopeSufficient(s)` is `s.split(" ").includes(OAUTH_SCOPE)`.

**Alternative considered**: gate `listDirectory` directly. Rejected: status is the contract-level entry point, and the rest of the engine already routes status failures into the bus correctly. Doing it once at status keeps the per-call paths clean.

### Decision 5 — `raw: { kind: "scope-insufficient", ... }` is the discriminator

The 9-tag taxonomy (`auth-expired`, `auth-revoked`, `not-found`, `conflict`, `unsupported`, `rate-limited`, `network-error`, `provider-error`, `cancelled`) is closed; we don't add a 10th. `auth-revoked` is correct semantically — the issued token cannot perform the requested ops, even though it is technically valid.

The `raw` field carries a structured object so consumers (today: tests; future: a tailored UI variant) can branch without parsing the message string. Shape:

```ts
{ kind: "scope-insufficient", requiredScope: string, actualScope: string }
```

`actualScope` is the space-separated string Google returned, preserved verbatim.

### Decision 6 — Credential persistence goes through the existing `CredentialStore` port

The base client already has `ctx.credentialStore` (used by `refreshTokenImpl` indirectly). The `parseTokenResponse` path mutates `this.creds` in memory; persistence to disk happens when the base re-emits the auth result. For the **backfill** path the strategy needs to call the credential store directly because no token exchange happened. We reuse the same port. The interface is `get/put/delete` (no separate `update`), so persisting a backfilled scope is a read-modify-write: `get` the current credential, splice `meta.scope` onto its `authResult.meta`, `put` it back. If the credential-store I/O fails (disk error, missing record), we **swallow and continue** — the scope is still good in-memory; the worst case is another `tokeninfo` round-trip on next process start.

## Risks / Trade-offs

- **Risk**: `tokeninfo` rate limits could hit users opening many Drive datasources in quick succession during a mass-backfill. → **Mitigation**: one call per datasource per process lifetime, persisted afterwards. The legacy backfill is one-time; new datasources never hit `tokeninfo` because they go through the token exchange path which already returns `scope`.
- **Risk**: Google could deprecate `tokeninfo` in favor of `userinfo` or another endpoint. → **Mitigation**: the endpoint has been documented and stable for >10 years. If it ever changes, the backfill helper is a single function to update.
- **Risk**: A credential store update during the backfill might race with another auth flow. → **Mitigation**: the credential-store update is a read-modify-write of a single key; the existing implementation is already serialized through atomic file rename. The scope field is monotonic — once set, the only thing that changes it is a re-consent through `parseTokenResponse`.
- **Trade-off**: The user-facing error message ("Drive permissions are too narrow…") is rendered by the existing generic `AuthRevokedState` UI today as the static "Sign in again to view files" copy. Until `add-drive-oauth-browser-consent` lands, the user sees a generic prompt with a Reconnect button that re-runs the same broken consent. The change still helps because it changes the `connected` → `auth-revoked` *state*, which at least shows the user *something is wrong*. Without this change, the file explorer renders an empty folder with no signal.
- **Trade-off**: We don't validate the issued scope at construction time, only at the first status/test-connection call. A datasource that is constructed but never has status checked could in theory ship past the detector. In practice, the supervisor calls `status` immediately after construction, so this is not a real gap.

## Migration Plan

1. The change is fully backward-compatible at the credential schema level: `meta.scope` is optional and additive.
2. Existing credentials in users' on-disk `credentials.json` files do not need to be touched ahead of time — the backfill via `tokeninfo` runs lazily on the first status call after upgrade.
3. Rollback: revert the `googledrive-client.ts` changes. `meta.scope`, if persisted, is harmless leftover data; future versions of the strategy ignore it without harm.
4. There is no data migration. Tests pre-populate `meta.scope` so the contract suite continues to pass.

## Open Questions

None blocking. All five questions in the original stub proposal have been resolved during this propose:

1. **Service-account?** No — the dev credential is OAuth-issued (`ya29.` access token; no `private_key`). Question retired.
2. **Reproduce with cleanly re-consented token?** Deferred to manual smoke-test once `add-drive-oauth-browser-consent` lands. Recorded as a deferred task in `tasks.md`.
3. **If service-account…** N/A.
4. **Scope drift detector** — implemented per Decisions 1–6.
5. **Shared drives** — out of scope; deferred to its own change.
