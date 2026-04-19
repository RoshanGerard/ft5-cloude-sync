// CredentialStore — the engine's abstract port for encrypted credential
// storage. The engine package is framework-agnostic (no Electron, no native
// SQLite); host processes supply a concrete implementation. In this
// monorepo, `apps/desktop` provides `SqliteCredentialStore` (Phase 4) which
// uses Electron's `safeStorage` + better-sqlite3. Non-Electron hosts (future
// CLI / web) are free to implement the same port against any key-managed
// store — Keychain-only, file + age, cloud KMS, etc.
//
// The port is intentionally minimal: three async operations keyed by
// `datasourceId`. No rotation / re-encryption helpers are part of the port
// in Phase 4; the implementation's on-disk row carries a `schema_version`
// column so a future port revision can add a `migrate()` method without
// breaking the v1 callers (see design.md Decision 8).
//
// Ported from an inline declaration that previously lived in
// `base-client.ts`; consumers keep importing `CredentialStore` from the
// package's public surface (`@ft5/fs-datasource-engine`) — this module
// relocation is invisible to them.

import type { StoredCredentials } from "@ft5/ipc-contracts";

/**
 * Encrypted credential storage port. The engine stays framework-agnostic;
 * the Electron host supplies a concrete implementation (Phase 4 —
 * `SqliteCredentialStore`).
 *
 * Contract:
 * - `get` returns `null` (not an error) when no row exists for the id.
 * - `put` is upsert semantics: re-putting the same id replaces the stored
 *   credential blob. Implementations that track row-level timestamps SHOULD
 *   preserve the original create time and advance the update time.
 * - `delete` is idempotent — calling it for a non-existent id MUST resolve
 *   without throwing.
 */
export interface CredentialStore {
  get(datasourceId: string): Promise<StoredCredentials | null>;
  put(datasourceId: string, creds: StoredCredentials): Promise<void>;
  delete(datasourceId: string): Promise<void>;
}
