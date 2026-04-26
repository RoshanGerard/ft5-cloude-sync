// Unit tests for ServiceConfigStore — reads `<dataDir>/config.json` for
// per-provider OAuth app config and exposes raw read/write for the future
// `sync:get-config` / `sync:set-config` handlers (§12).
//
// Spec: `openspec/changes/implement-datasource-onboarding/specs/fs-sync-service/spec.md`
// Requirement "ServiceConfigStore reads ~/ft5/sync_app/config.json for OAuth
// app config" + design.md Decision 4. The atomic-write + 0o600 pattern
// mirrors `services/fs-sync/src/credential-store/config-file.ts`.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ServiceConfigMissingError,
  ServiceConfigStore,
} from "../service-config-store.js";

let cleanupDirs: string[] = [];

async function scratchDir(): Promise<string> {
  const dir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "ft5-svc-config-"),
  );
  cleanupDirs.push(dir);
  return dir;
}

beforeEach(() => {
  cleanupDirs = [];
});

afterEach(async () => {
  for (const dir of cleanupDirs) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
});

const SAMPLE_REDIRECT = "http://127.0.0.1:54321/callback";

describe("ServiceConfigStore — getOAuthAppConfig", () => {
  it("returns clientId/clientSecret from disk and the injected redirectUri (happy path)", async () => {
    const dir = await scratchDir();
    const file = path.join(dir, "config.json");
    await fsp.writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          "google-drive": { clientId: "abc", clientSecret: "def" },
        },
      }),
      "utf8",
    );
    const store = new ServiceConfigStore({ filePath: file });

    const cfg = await store.getOAuthAppConfig("google-drive", SAMPLE_REDIRECT);
    expect(cfg).toEqual({
      clientId: "abc",
      clientSecret: "def",
      redirectUri: SAMPLE_REDIRECT,
    });
  });

  it("throws ServiceConfigMissingError when the file is absent", async () => {
    const dir = await scratchDir();
    const file = path.join(dir, "config.json");
    const store = new ServiceConfigStore({ filePath: file });

    let caught: unknown;
    try {
      await store.getOAuthAppConfig("google-drive", SAMPLE_REDIRECT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceConfigMissingError);
    const e = caught as ServiceConfigMissingError;
    expect(e.path).toBe(path.resolve(file));
    expect(e.providerId).toBe("google-drive");
    expect(e.name).toBe("ServiceConfigMissingError");
  });

  it("throws ServiceConfigMissingError when the file cannot be parsed", async () => {
    const dir = await scratchDir();
    const file = path.join(dir, "config.json");
    await fsp.writeFile(file, "{not json", "utf8");
    const store = new ServiceConfigStore({ filePath: file });

    await expect(
      store.getOAuthAppConfig("google-drive", SAMPLE_REDIRECT),
    ).rejects.toBeInstanceOf(ServiceConfigMissingError);
  });

  it("throws ServiceConfigMissingError when the provider entry is absent", async () => {
    const dir = await scratchDir();
    const file = path.join(dir, "config.json");
    await fsp.writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          onedrive: { clientId: "abc", clientSecret: "def" },
        },
      }),
      "utf8",
    );
    const store = new ServiceConfigStore({ filePath: file });

    let caught: unknown;
    try {
      await store.getOAuthAppConfig("google-drive", SAMPLE_REDIRECT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceConfigMissingError);
    const e = caught as ServiceConfigMissingError;
    expect(e.providerId).toBe("google-drive");
    expect(e.path).toBe(path.resolve(file));
  });

  it("throws ServiceConfigMissingError when clientId is empty", async () => {
    const dir = await scratchDir();
    const file = path.join(dir, "config.json");
    await fsp.writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          "google-drive": { clientId: "", clientSecret: "def" },
        },
      }),
      "utf8",
    );
    const store = new ServiceConfigStore({ filePath: file });

    await expect(
      store.getOAuthAppConfig("google-drive", SAMPLE_REDIRECT),
    ).rejects.toBeInstanceOf(ServiceConfigMissingError);
  });

  it("throws ServiceConfigMissingError when clientSecret is empty", async () => {
    const dir = await scratchDir();
    const file = path.join(dir, "config.json");
    await fsp.writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          "google-drive": { clientId: "abc", clientSecret: "" },
        },
      }),
      "utf8",
    );
    const store = new ServiceConfigStore({ filePath: file });

    await expect(
      store.getOAuthAppConfig("google-drive", SAMPLE_REDIRECT),
    ).rejects.toBeInstanceOf(ServiceConfigMissingError);
  });
});

describe("ServiceConfigStore — getRaw / setRaw", () => {
  it("returns the empty default when the file is absent", async () => {
    const dir = await scratchDir();
    const file = path.join(dir, "config.json");
    const store = new ServiceConfigStore({ filePath: file });

    const raw = await store.getRaw();
    expect(raw).toEqual({ schemaVersion: 1, providers: {} });
  });

  it("setRaw + getRaw round-trips deep-equal", async () => {
    const dir = await scratchDir();
    const file = path.join(dir, "config.json");
    const store = new ServiceConfigStore({ filePath: file });

    const next = {
      schemaVersion: 1 as const,
      providers: {
        "google-drive": { clientId: "x", clientSecret: "y" },
        onedrive: { clientId: "p", clientSecret: "q" },
      },
    };
    await store.setRaw(next);
    const back = await store.getRaw();
    expect(back).toEqual(next);
  });

  it("after setRaw, getOAuthAppConfig returns the entry with injected redirectUri", async () => {
    const dir = await scratchDir();
    const file = path.join(dir, "config.json");
    const store = new ServiceConfigStore({ filePath: file });

    await store.setRaw({
      schemaVersion: 1,
      providers: {
        "google-drive": { clientId: "x", clientSecret: "y" },
      },
    });
    const cfg = await store.getOAuthAppConfig(
      "google-drive",
      SAMPLE_REDIRECT,
    );
    expect(cfg).toEqual({
      clientId: "x",
      clientSecret: "y",
      redirectUri: SAMPLE_REDIRECT,
    });
  });
});

describe.skipIf(process.platform === "win32")(
  "ServiceConfigStore — Unix file mode",
  () => {
    it("setRaw writes the file with mode 0o600", async () => {
      const dir = await scratchDir();
      const file = path.join(dir, "config.json");
      const store = new ServiceConfigStore({ filePath: file });

      await store.setRaw({
        schemaVersion: 1,
        providers: {
          "google-drive": { clientId: "x", clientSecret: "y" },
        },
      });
      const stat = await fsp.stat(file);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  },
);
