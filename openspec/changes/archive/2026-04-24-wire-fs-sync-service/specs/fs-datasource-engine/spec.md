## REMOVED Requirements

### Requirement: CredentialStore port + SqliteCredentialStore implementation

**Reason**: The `SqliteCredentialStore` class and its Electron `safeStorage` wiring were a desktop-specific implementation of the engine's `CredentialStore` port. With the sync service now owning all credential writes (see `fs-sync-service` capability, requirement `sync:authenticate` is the canonical credential-writing entry point), there is exactly one `CredentialStore` implementor in the repository — the service's `ConfigFileCredentialStore`. The desktop app no longer opens, reads, or writes credentials. Keeping the desktop-specific implementation requirement in this spec would mandate code that has been deliberately deleted.

The abstract `CredentialStore` port itself REMAINS — it is still declared in `packages/fs-datasource-engine/src/credential-store.ts` and imported by both the service and any future non-Electron host (CLI, web) that implements it. Only the desktop-specific `SqliteCredentialStore` obligation is removed.

**Migration**:

- Delete `apps/desktop/src/main/datasources/sqlite-credential-store.ts` and its tests.
- Add a forward-only Drizzle migration `0002_drop_datasource_credentials` that executes `DROP TABLE IF EXISTS datasource_credentials` on the desktop SQLite database.
- Remove the `DEFAULT_MIGRATIONS` entry for `0001_datasource_credentials` from `apps/desktop/src/main/db/migrations.ts` (leaving only `0002` and any subsequent migrations). Developers with existing dev databases will run `0002` on next start, dropping the table; their encrypted credentials are lost and they must re-authenticate every datasource via the new `sync:authenticate` flow.
- No changes to `packages/fs-datasource-engine/src/credential-store.ts` (the port). No changes to `@ft5/ipc-contracts` types tied to credentials.
- Any downstream consumer that imported `SqliteCredentialStore` from `apps/desktop/src/main/datasources/` SHALL be updated to call `window.api.sync.authenticate` (renderer) or the service's `sync:authenticate` command (main / other backends) instead.

### Requirement: Renderer-relevant stale comment cleanup in engine index

**Reason**: Not a spec-level requirement removal — documentation maintenance only. The comment block at `packages/fs-datasource-engine/src/index.ts:52-53` still calls the three provider strategies "three placeholder strategy stubs," dating from the Phase-5 scaffold. Phases 6–8 replaced them with 780 / 1054 / 1334-line real implementations (S3, OneDrive, Google Drive) that pass contract tests. The comment is misleading to new readers.

**Migration**: Rewrite the comment to reflect current state (three full strategy implementations, each with contract tests; the factory's integrity validation still applies to any future strategy addition). This is editorial only and introduces no requirement change.
