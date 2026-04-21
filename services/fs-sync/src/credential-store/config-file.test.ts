import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { StoredCredentials } from "@ft5/ipc-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConfigFileCredentialStore,
  CredentialStorePermissionError,
} from "./config-file.js";

let cleanup: string[] = [];

afterEach(async () => {
  for (const f of cleanup) {
    try {
      await fsp.rm(f, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
  cleanup = [];
});

function scratchDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `ft5-sync-creds-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  cleanup.push(dir);
  return dir;
}

function sampleCreds(token = "abc"): StoredCredentials {
  return {
    providerId: "amazon-s3",
    authResult: { accessToken: token, refreshToken: "r-1" },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

describe("ConfigFileCredentialStore — happy-path round trip (task 4.1)", () => {
  it("put then get returns the stored credentials", async () => {
    const dir = scratchDir();
    const file = path.join(dir, "credentials.json");
    const store = new ConfigFileCredentialStore({ filePath: file });

    await store.put("ds-1", sampleCreds("abc"));
    const back = await store.get("ds-1");
    expect(back).toEqual(sampleCreds("abc"));
  });

  it("on-disk file contains the literal token strings (plaintext v1)", async () => {
    const dir = scratchDir();
    const file = path.join(dir, "credentials.json");
    const store = new ConfigFileCredentialStore({ filePath: file });

    await store.put("ds-1", sampleCreds("abc"));
    const raw = await fsp.readFile(file, "utf8");
    expect(raw).toContain('"accessToken": "abc"');
    expect(raw).toContain('"refreshToken": "r-1"');
    expect(JSON.parse(raw)).toMatchObject({
      schemaVersion: 1,
      credentials: { "ds-1": sampleCreds("abc") },
    });
  });

  it("get returns null for an unknown id", async () => {
    const dir = scratchDir();
    const store = new ConfigFileCredentialStore({
      filePath: path.join(dir, "credentials.json"),
    });
    // File doesn't exist yet — get should reject because read() rethrows
    // ENOENT without createIfMissing. Wrapping with .catch to accept
    // either behaviour is wrong; spec says get returns null when NO row
    // matches, not when the file is missing. We treat missing-file as "no
    // rows", i.e. null.
    await store.put("ds-1", sampleCreds());
    expect(await store.get("ds-2")).toBeNull();
  });

  it("delete removes one entry but preserves the file and siblings", async () => {
    const dir = scratchDir();
    const file = path.join(dir, "credentials.json");
    const store = new ConfigFileCredentialStore({ filePath: file });

    await store.put("ds-1", sampleCreds("a"));
    await store.put("ds-2", sampleCreds("b"));
    await store.delete("ds-1");

    expect(await store.get("ds-1")).toBeNull();
    expect(await store.get("ds-2")).toEqual(sampleCreds("b"));

    const raw = JSON.parse(await fsp.readFile(file, "utf8"));
    expect(raw).toEqual({
      schemaVersion: 1,
      credentials: { "ds-2": sampleCreds("b") },
    });
  });

  it("delete is idempotent for a missing id", async () => {
    const dir = scratchDir();
    const store = new ConfigFileCredentialStore({
      filePath: path.join(dir, "credentials.json"),
    });
    await store.put("ds-1", sampleCreds());
    await expect(store.delete("ds-nonexistent")).resolves.toBeUndefined();
    expect(await store.get("ds-1")).toEqual(sampleCreds());
  });
});

describe("ConfigFileCredentialStore — atomic write + crash recovery (task 4.5)", () => {
  it("leaves the previously-committed value readable after a simulated crash", async () => {
    const dir = scratchDir();
    const file = path.join(dir, "credentials.json");
    const store = new ConfigFileCredentialStore({ filePath: file });

    await store.put("ds-1", sampleCreds("committed"));

    // Simulate crash: write a leftover .tmp file (half-written second put)
    // and assert the committed value is still readable from the real file.
    await fsp.writeFile(
      `${file}.tmp`,
      '{"schemaVersion":1,"credentials":{"ds-1":"garbage"}}',
    );
    const back = await store.get("ds-1");
    expect(back).toEqual(sampleCreds("committed"));
  });

  it("cleanupOrphanTmp removes a leftover .tmp on startup", async () => {
    const dir = scratchDir();
    const file = path.join(dir, "credentials.json");
    const store = new ConfigFileCredentialStore({ filePath: file });

    await store.put("ds-1", sampleCreds("committed"));
    await fsp.writeFile(`${file}.tmp`, "garbage");
    const found = await store.cleanupOrphanTmp();
    expect(found).toBe(true);
    await expect(fsp.stat(`${file}.tmp`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Committed value is untouched.
    expect(await store.get("ds-1")).toEqual(sampleCreds("committed"));
  });

  it("cleanupOrphanTmp is a no-op when no leftover exists", async () => {
    const dir = scratchDir();
    const store = new ConfigFileCredentialStore({
      filePath: path.join(dir, "credentials.json"),
    });
    expect(await store.cleanupOrphanTmp()).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")(
  "ConfigFileCredentialStore — Unix permission enforcement (task 4.3)",
  () => {
    it("writes mode 0o600 on put", async () => {
      const dir = scratchDir();
      const file = path.join(dir, "credentials.json");
      const store = new ConfigFileCredentialStore({ filePath: file });
      await store.put("ds-1", sampleCreds());
      const stat = await fsp.stat(file);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("refuses to read when the file has widened mode 0o644", async () => {
      const dir = scratchDir();
      const file = path.join(dir, "credentials.json");
      const store = new ConfigFileCredentialStore({ filePath: file });
      await store.put("ds-1", sampleCreds());
      await fsp.chmod(file, 0o644);

      await expect(store.get("ds-1")).rejects.toBeInstanceOf(
        CredentialStorePermissionError,
      );
    });

    it("emits credential-store-permission-violation with the observed mode", async () => {
      const dir = scratchDir();
      const file = path.join(dir, "credentials.json");
      const sink = { emit: vi.fn() };
      const store = new ConfigFileCredentialStore({
        filePath: file,
        eventSink: sink,
      });
      await store.put("ds-1", sampleCreds());
      await fsp.chmod(file, 0o644);

      await expect(store.get("ds-1")).rejects.toBeInstanceOf(
        CredentialStorePermissionError,
      );
      expect(sink.emit).toHaveBeenCalledWith(
        "credential-store-permission-violation",
        expect.objectContaining({
          path: file,
          mode: "0o644",
        }),
      );
    });

    it("proceeds normally when mode is 0o600", async () => {
      const dir = scratchDir();
      const file = path.join(dir, "credentials.json");
      const sink = { emit: vi.fn() };
      const store = new ConfigFileCredentialStore({
        filePath: file,
        eventSink: sink,
      });
      await store.put("ds-1", sampleCreds());
      // mode is already 0o600 after put
      const back = await store.get("ds-1");
      expect(back).toEqual(sampleCreds());
      expect(sink.emit).not.toHaveBeenCalled();
    });
  },
);
