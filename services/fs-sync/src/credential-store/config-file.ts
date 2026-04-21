// ConfigFileCredentialStore — a CredentialStore port impl that persists
// plaintext JSON at `$HOME/ft5/sync_app/credentials.json`. Writes are
// atomic (write-to-tmp + fs.rename). On Unix the file is chmod'd to 0o600
// after every write AND fs.stat-checked for permission widening on every
// read; a widened mode raises `CredentialStorePermissionError` and emits
// a `credential-store-permission-violation` event on an injected emitter.
//
// Spec: "ConfigFileCredentialStore implements the engine's CredentialStore
// port" and "Credential file refuses to operate when permissions widen
// (Unix)". Plaintext is a documented v1 deferred tradeoff (design.md D4).

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { CredentialStore } from "@ft5/fs-datasource-engine";
import type { StoredCredentials } from "@ft5/ipc-contracts";

export class CredentialStorePermissionError extends Error {
  readonly observedMode: string;
  readonly filePath: string;
  constructor(filePath: string, observedMode: string) {
    super(
      `credentials file ${filePath} has widened permissions (observed ${observedMode}); refusing to read or write`,
    );
    this.name = "CredentialStorePermissionError";
    this.filePath = filePath;
    this.observedMode = observedMode;
  }
}

export interface PermissionViolationPayload {
  readonly path: string;
  readonly mode: string;
  readonly observedAt: number;
}

export interface CredentialStoreEventSink {
  emit(name: "credential-store-permission-violation", payload: PermissionViolationPayload): void;
}

interface StoredFile {
  schemaVersion: 1;
  credentials: Record<string, StoredCredentials>;
}

const EMPTY: StoredFile = { schemaVersion: 1, credentials: {} };

export interface ConfigFileCredentialStoreOptions {
  readonly filePath: string;
  readonly eventSink?: CredentialStoreEventSink;
}

export class ConfigFileCredentialStore implements CredentialStore {
  private readonly filePath: string;
  private readonly tmpPath: string;
  private readonly eventSink: CredentialStoreEventSink | null;

  constructor(options: ConfigFileCredentialStoreOptions) {
    this.filePath = options.filePath;
    this.tmpPath = `${options.filePath}.tmp`;
    this.eventSink = options.eventSink ?? null;
  }

  /**
   * Clean up any orphan `credentials.json.tmp` that was left behind by a
   * crash between `write` and `rename`. Safe to call at service startup.
   * Returns whether a leftover file was found and removed.
   */
  async cleanupOrphanTmp(): Promise<boolean> {
    try {
      await fsp.unlink(this.tmpPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async get(datasourceId: string): Promise<StoredCredentials | null> {
    const content = await this.read();
    return content.credentials[datasourceId] ?? null;
  }

  async put(datasourceId: string, creds: StoredCredentials): Promise<void> {
    const content = await this.read({ createIfMissing: true });
    const next: StoredFile = {
      schemaVersion: 1,
      credentials: { ...content.credentials, [datasourceId]: creds },
    };
    await this.write(next);
  }

  async delete(datasourceId: string): Promise<void> {
    let content: StoredFile;
    try {
      content = await this.read();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (!(datasourceId in content.credentials)) return;
    const next: Record<string, StoredCredentials> = { ...content.credentials };
    delete next[datasourceId];
    await this.write({ schemaVersion: 1, credentials: next });
  }

  private async read(opts: { createIfMissing?: boolean } = {}): Promise<StoredFile> {
    try {
      await this.assertMode();
      const raw = await fsp.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoredFile;
      if (parsed.schemaVersion !== 1 || typeof parsed.credentials !== "object") {
        throw new Error(
          `credentials file ${this.filePath} has unexpected shape; refusing to read`,
        );
      }
      return parsed;
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT" &&
        opts.createIfMissing
      ) {
        return { ...EMPTY, credentials: {} };
      }
      throw err;
    }
  }

  private async write(next: StoredFile): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const json = `${JSON.stringify(next, null, 2)}\n`;
    // Atomic: write then rename. If the process dies between these two
    // calls, `cleanupOrphanTmp` removes the leftover on next startup; the
    // old file content remains readable.
    await fsp.writeFile(this.tmpPath, json, { mode: 0o600, flag: "w" });
    if (process.platform !== "win32") {
      await fsp.chmod(this.tmpPath, 0o600);
    }
    await fsp.rename(this.tmpPath, this.filePath);
    if (process.platform !== "win32") {
      await fsp.chmod(this.filePath, 0o600);
    }
  }

  /**
   * Refuse to operate if the credentials file has group or other access.
   * On Windows this check is a no-op — the analogous ACL check would require
   * shelling out to `icacls`; the installer sets the correct ACL at install
   * time and the user-only service identity is the primary guarantee.
   */
  private async assertMode(): Promise<void> {
    if (process.platform === "win32") return;
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const bits = stat.mode & 0o777;
    if ((bits & 0o077) !== 0) {
      const observed = `0o${bits.toString(8).padStart(3, "0")}`;
      this.eventSink?.emit("credential-store-permission-violation", {
        path: this.filePath,
        mode: observed,
        observedAt: Date.now(),
      });
      throw new CredentialStorePermissionError(this.filePath, observed);
    }
  }
}
