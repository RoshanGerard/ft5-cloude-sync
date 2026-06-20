## Why

The file explorer shows two different "reconnect" full-replace states depending on the engine error tag, and they diverge in both look and behaviour:

- `invalid-datasource` → an inline view that reconnects in place (re-runs the authenticate flow, then re-lists).
- `auth-revoked` → an amber view whose "Reconnect" button merely navigates back to the dashboard (`router.push("/")`). From inside the explorer this reads as "nothing happens."

Because Google Drive uniquely raises `auth-revoked` on insufficient OAuth scope (googledrive-client.ts) while other reconnect-needed conditions surface as `invalid-datasource`, the same user action produces inconsistent experiences across datasources. Separately, **no** reconnect surface handles credential-based providers: Amazon S3's "Reconnect" silently no-ops because every handler acts only on the OAuth branch of `authenticateStart`.

## What Changes

- Collapse the explorer's two reconnect states (`auth-revoked` + `invalid-datasource`) into **one shared reconnect-required view** rendered for both error tags — the inline view, not the navigate-away one.
- **BREAKING** (UI behaviour): remove the `AuthRevokedState` navigate-to-dashboard behaviour. `auth-revoked` now renders the unified inline reconnect view instead of bouncing the user to the dashboard.
- Make Reconnect work for **every** datasource type by dispatching on the provider's `credentialsSchema` (the same extensibility pattern the Add dialog uses):
  - OAuth providers (Google Drive, OneDrive): Reconnect opens the browser sign-in directly (unchanged behaviour).
  - Credential-based providers (Amazon S3, custom): Reconnect expands the keys form **inline** in the explorer.
- Thread `datasourceId` into `AwsAccessKeyForm` + `CustomForm` so they re-authenticate the **existing** datasource (matching `OAuthForm`, which already accepts it). This is the actual fix for S3's silent no-op.
- Surface inline error feedback when a Reconnect attempt fails, instead of silently re-enabling the button.

No IPC/wire change and no service change: the sync service already honours a caller-supplied `datasourceId` for the credentials-form path.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `file-explorer`: the reconnect/error full-replace states change — `auth-revoked` and `invalid-datasource` now render one shared reconnect-required state; the `auth-revoked` navigate-to-dashboard behaviour is removed; a credential-form inline reconnect path is added.
- `datasources-ui`: the credential forms change — `AwsAccessKeyForm` and `CustomForm` accept a `datasourceId` and support the reconnect (re-auth existing datasource) path, parallel to `OAuthForm`.

## Impact

- **Renderer only.** Affected code:
  - `apps/desktop/src/renderer/src/features/file-explorer/states/` — unify `invalid-datasource.tsx` into a shared reconnect view; delete `auth-revoked.tsx`.
  - `apps/desktop/src/renderer/src/features/file-explorer/file-explorer.tsx` — route both tags to the unified view; drop the `AuthRevokedState` import and `router.push` reconnect handler.
  - `apps/desktop/src/renderer/src/features/datasources/credential-forms/aws-access-key-form.tsx` + `custom-form.tsx` — add and thread `datasourceId`.
- **No** change to `fs-sync-service`, `fs-datasource-engine`, IPC contracts, or the dashboard card banners (the cards share the OAuth-only limitation but are out of scope here — tracked as a follow-up).
- **No** new dependencies.
