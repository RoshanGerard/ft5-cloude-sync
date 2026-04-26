// Tests for the `sync:set-config` handler — implement-datasource-
// onboarding §12. Thin wrapper around `ServiceConfigStore.setRaw(...)`.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServiceConfigStore } from "../config/service-config-store.js";
import type { Connection } from "../ipc/server.js";

import { makeSetConfigHandler } from "./set-config.js";
import { makeGetConfigHandler } from "./get-config.js";

const ctx = (): { readonly connection: Connection } => ({
  connection: {
    id: 1,
    closed: false,
    sendEvent: () => void 0,
  },
});

describe("sync:set-config handler — implement-datasource-onboarding §12", () => {
  let dir: string;
  let store: ServiceConfigStore;
  let configPath: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ft5-setcfg-"));
    configPath = path.join(dir, "config.json");
    store = new ServiceConfigStore({ filePath: configPath });
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("writes the file, then a subsequent get-config returns the same shape", async () => {
    const setHandler = makeSetConfigHandler({ configStore: store });
    const getHandler = makeGetConfigHandler({ configStore: store });

    const setRes = await setHandler(
      {
        config: {
          schemaVersion: 1,
          providers: {
            "google-drive": { clientId: "X", clientSecret: "Y" },
          },
        },
      },
      ctx(),
    );
    expect(setRes.ok).toBe(true);
    if (!setRes.ok) return;
    expect(setRes.result).toEqual({ ok: true });

    const getRes = await getHandler({}, ctx());
    expect(getRes.ok).toBe(true);
    if (!getRes.ok) return;
    expect(getRes.result.config).toEqual({
      schemaVersion: 1,
      providers: {
        "google-drive": { clientId: "X", clientSecret: "Y" },
      },
    });
  });

  it.runIf(process.platform !== "win32")(
    "set-config writes the file at mode 0o600 on Unix",
    async () => {
      const setHandler = makeSetConfigHandler({ configStore: store });
      await setHandler(
        {
          config: { schemaVersion: 1, providers: {} },
        },
        ctx(),
      );
      const stat = await fsp.stat(configPath);
      // Mask off file-type bits, keep permission bits.
      expect((stat.mode & 0o777).toString(8)).toBe("600");
    },
  );

  it("propagates store throws as io-error tag", async () => {
    const setHandler = makeSetConfigHandler({ configStore: store });

    // schemaVersion !== 1 triggers ServiceConfigStore.setRaw to throw a
    // plain Error (per §6 implementation). The handler maps to io-error.
    const res = await setHandler(
      {
        config: { schemaVersion: 1, providers: {} } as never,
      } as never,
      ctx(),
    );
    expect(res.ok).toBe(true); // baseline — clean write should still succeed
    // (We exercise the failure path by passing an invalid config below.)

    const res2 = await setHandler(
      {
        config: { schemaVersion: 2 as 1, providers: {} } as never,
      } as never,
      ctx(),
    );
    expect(res2.ok).toBe(false);
    if (res2.ok) return;
    expect(res2.error.tag).toBe("io-error");
    if (res2.error.tag !== "io-error") return;
    expect(res2.error.message).toMatch(/schemaVersion/);
  });
});
