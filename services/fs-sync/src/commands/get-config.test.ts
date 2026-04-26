// Tests for the `sync:get-config` handler — implement-datasource-
// onboarding §12. Thin wrapper around `ServiceConfigStore.getRaw()`.
// Returns the empty default `{schemaVersion: 1, providers: {}}` when
// the file is absent. Other I/O errors propagate as `{tag: "io-error"}`.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServiceConfigStore } from "../config/service-config-store.js";
import type { Connection } from "../ipc/server.js";

import { makeGetConfigHandler } from "./get-config.js";

const ctx = (): { readonly connection: Connection } => ({
  connection: {
    id: 1,
    closed: false,
    sendEvent: () => void 0,
  },
});

describe("sync:get-config handler — implement-datasource-onboarding §12", () => {
  let dir: string;
  let store: ServiceConfigStore;
  let configPath: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ft5-getcfg-"));
    configPath = path.join(dir, "config.json");
    store = new ServiceConfigStore({ filePath: configPath });
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("returns the empty default shape when the config file is absent", async () => {
    const handler = makeGetConfigHandler({ configStore: store });

    const res = await handler({}, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.config).toEqual({
      schemaVersion: 1,
      providers: {},
    });
  });

  it("round-trips through setRaw + getRaw with the populated providers map", async () => {
    await store.setRaw({
      schemaVersion: 1,
      providers: {
        "google-drive": { clientId: "abc", clientSecret: "def" },
      },
    });
    const handler = makeGetConfigHandler({ configStore: store });

    const res = await handler({}, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.config).toEqual({
      schemaVersion: 1,
      providers: {
        "google-drive": { clientId: "abc", clientSecret: "def" },
      },
    });
  });

  it("propagates non-ENOENT errors as io-error tag", async () => {
    // Write garbage so JSON.parse throws — getRaw re-throws non-ENOENT
    // errors per the §6 implementation.
    await fsp.writeFile(configPath, "this is not json", "utf8");
    const handler = makeGetConfigHandler({ configStore: store });

    const res = await handler({}, ctx());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("io-error");
    if (res.error.tag !== "io-error") return;
    expect(typeof res.error.message).toBe("string");
    expect(res.error.message.length).toBeGreaterThan(0);
  });
});
