// ServiceConfigStore — reads `<dataDir>/config.json` and exposes per-provider
// OAuth app config to `sync:authenticate-start`. Writes are atomic
// (write-to-tmp + rename + chmod 0o600 on Unix), mirroring the pattern in
// `services/fs-sync/src/credential-store/config-file.ts` so tests and operators
// see one consistent on-disk shape across the service's two config files.
//
// Spec: `openspec/changes/implement-datasource-onboarding/specs/fs-sync-service/spec.md`
// Requirement "ServiceConfigStore reads ~/ft5/sync_app/config.json for OAuth
// app config" + design.md Decision 4. The thrown `ServiceConfigMissingError`
// surfaces through `handleAuthenticateStart` (§9) as the wire error
// `{ tag: "service-config-missing", path, providerId }`.
//
// `redirectUri` is NOT stored in the file — the loopback broker (§8) computes
// it per-session from the OS-allocated ephemeral port and threads it through
// as a parameter at `getOAuthAppConfig` time. This keeps the store oblivious
// to runtime port allocation and lets `setRaw` carry vendor-only fields.

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { ServiceConfig } from "@ft5/ipc-contracts/sync-service";
import type { ProviderId } from "@ft5/ipc-contracts";
import type { OAuthAppConfig } from "@ft5/fs-datasource-engine";

/**
 * Thrown by `getOAuthAppConfig` when the requested provider's app config is
 * absent, malformed, or has empty `clientId`/`clientSecret`. The `path` is
 * the absolute resolved file path so the renderer copy can show the user
 * exactly which file to populate; the `providerId` is the requested key so
 * the renderer can scope the message to the provider the user clicked.
 *
 * The `reason` constructor argument disambiguates the four failure modes for
 * service-side diagnostics (file absent, file unparseable, provider entry
 * absent, provider entry has empty fields). It does NOT cross the wire — only
 * `path` and `providerId` reach the renderer per the contract surface.
 */
export class ServiceConfigMissingError extends Error {
  readonly path: string;
  readonly providerId: ProviderId;
  constructor(filePath: string, providerId: ProviderId, reason: string) {
    super(
      `OAuth app config missing for ${providerId} at ${filePath}: ${reason}`,
    );
    this.name = "ServiceConfigMissingError";
    this.path = filePath;
    this.providerId = providerId;
  }
}

const EMPTY: ServiceConfig = { schemaVersion: 1, providers: {} };

export interface ServiceConfigStoreOptions {
  readonly filePath: string;
}

export class ServiceConfigStore {
  private readonly filePath: string;
  private readonly tmpPath: string;

  constructor(options: ServiceConfigStoreOptions) {
    // Resolve to an absolute path so `ServiceConfigMissingError.path` is
    // unambiguous regardless of the cwd at construction time.
    this.filePath = path.resolve(options.filePath);
    this.tmpPath = `${this.filePath}.tmp`;
  }

  /**
   * Read the per-provider OAuth app config and combine it with the per-session
   * `redirectUri` supplied by the broker. Throws `ServiceConfigMissingError`
   * when the file is absent, unparseable, missing the requested provider, or
   * the entry has empty `clientId`/`clientSecret`.
   */
  async getOAuthAppConfig(
    providerId: ProviderId,
    redirectUri: string,
  ): Promise<OAuthAppConfig> {
    let config: ServiceConfig;
    try {
      config = await this.read();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ServiceConfigMissingError(
          this.filePath,
          providerId,
          "config file does not exist",
        );
      }
      if (err instanceof SyntaxError) {
        throw new ServiceConfigMissingError(
          this.filePath,
          providerId,
          `config file could not be parsed: ${err.message}`,
        );
      }
      // Any other error from read() — including a schema-version mismatch —
      // is a config-level miss as far as the caller is concerned.
      throw new ServiceConfigMissingError(
        this.filePath,
        providerId,
        err instanceof Error ? err.message : String(err),
      );
    }

    const entry = config.providers[providerId];
    if (entry === undefined) {
      throw new ServiceConfigMissingError(
        this.filePath,
        providerId,
        "provider entry is absent from config",
      );
    }
    if (entry.clientId === "") {
      throw new ServiceConfigMissingError(
        this.filePath,
        providerId,
        "clientId is empty",
      );
    }
    if (entry.clientSecret === "") {
      throw new ServiceConfigMissingError(
        this.filePath,
        providerId,
        "clientSecret is empty",
      );
    }
    return {
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
      redirectUri,
    };
  }

  /**
   * Read the full parsed config — used by `sync:get-config`. Returns the
   * empty default `{schemaVersion: 1, providers: {}}` when the file does not
   * exist (per spec scenario "get-config returns the empty shape when file is
   * absent"). Other I/O errors propagate.
   */
  async getRaw(): Promise<ServiceConfig> {
    try {
      return await this.read();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...EMPTY, providers: {} };
      }
      throw err;
    }
  }

  /**
   * Atomically write the full config — used by `sync:set-config`. Mirrors
   * `ConfigFileCredentialStore.write`: write tmp + chmod 0o600 (Unix) +
   * rename. Unlike the credential store this one does NOT enforce a
   * permission-widening read check; the OAuth-app secrets are documented v1
   * plaintext (Risks §2 in design.md) and the operator-edit workflow makes
   * widened-mode reads expected (e.g. just after a manual `cp` from the
   * checked-in `config.example.json`).
   */
  async setRaw(next: ServiceConfig): Promise<void> {
    if (next.schemaVersion !== 1) {
      throw new Error(
        `service config schemaVersion must be 1, got ${String(next.schemaVersion)}`,
      );
    }
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const json = `${JSON.stringify(next, null, 2)}\n`;
    await fsp.writeFile(this.tmpPath, json, { mode: 0o600, flag: "w" });
    if (process.platform !== "win32") {
      await fsp.chmod(this.tmpPath, 0o600);
    }
    await fsp.rename(this.tmpPath, this.filePath);
    if (process.platform !== "win32") {
      await fsp.chmod(this.filePath, 0o600);
    }
  }

  private async read(): Promise<ServiceConfig> {
    const raw = await fsp.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as ServiceConfig;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.providers !== "object"
    ) {
      throw new Error(
        `service config file ${this.filePath} has unexpected shape; refusing to read`,
      );
    }
    return parsed;
  }
}
