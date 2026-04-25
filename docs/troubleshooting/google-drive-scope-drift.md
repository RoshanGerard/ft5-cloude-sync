# Google Drive: scope drift

## Symptom

A Google Drive datasource shows status `connected` but the file explorer lists
only files uploaded through this app. Pre-existing files in your Drive are
invisible. After the scope-detection work lands, the datasource may instead
show `auth-revoked` with the message "Drive permissions are too narrow —
reconnect with full access to see your existing files."

## Cause

The OAuth refresh token in your `credentials.json` was issued under a narrower
scope -- most likely `https://www.googleapis.com/auth/drive.file`, which
restricts the app to files it created. Changing the requested scope in source
code does not retroactively widen an already-issued refresh token. That
requires re-consent.

## What the engine does

At connect time, `status()` and `testConnection()` inspect the scope stored on
the credential. When the full `https://www.googleapis.com/auth/drive` scope is
absent, the engine fails with:

```
tag:           "auth-revoked"
retryable:     false
raw.kind:      "scope-insufficient"
raw.requiredScope: "https://www.googleapis.com/auth/drive"
raw.actualScope:   <the narrow scope that was found>
```

The file explorer enters `AuthRevokedState` ("Sign in again to view files").

## Remedy (today)

Interactive browser re-consent is not yet shipped (tracked in change
`add-drive-oauth-browser-consent`). Until it lands, the workaround is:

1. Delete `$HOME/ft5/sync_app/dev/credentials.json`.
2. Re-run whatever provisioning flow originally generated it.
3. At the Google consent screen, grant the full
   `https://www.googleapis.com/auth/drive` scope.

## Forward pointer

Once `add-drive-oauth-browser-consent` ships, the Reconnect button on the
`AuthRevokedState` UI will trigger re-consent automatically. That change's
proposal documents the browser-flow design.
