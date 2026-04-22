import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLogger, redactCommandParams } from "./logger.js";

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

function scratch(): string {
  const d = path.join(
    os.tmpdir(),
    `ft5-sync-log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  cleanup.push(d);
  return path.join(d, "service.log");
}

async function readAll(p: string): Promise<string> {
  return (await fsp.readFile(p, "utf8")).toString();
}

describe("createLogger — format", () => {
  it("emits JSON lines with ts, level, msg, and extra fields", async () => {
    const f = scratch();
    const log = createLogger({ filePath: f, level: "debug" });
    log.info("hello", { jobId: "j-1" });
    log.close();
    const lines = (await readAll(f)).trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(rec["level"]).toBe("info");
    expect(rec["msg"]).toBe("hello");
    expect(rec["jobId"]).toBe("j-1");
    expect(typeof rec["ts"]).toBe("string");
  });

  it("honours the LOG_LEVEL gate: debug messages suppressed at info level", async () => {
    const f = scratch();
    const log = createLogger({ filePath: f, level: "info" });
    log.debug("should not appear");
    log.info("should appear");
    log.close();
    const text = await readAll(f);
    expect(text).not.toContain("should not appear");
    expect(text).toContain("should appear");
  });
});

describe("createLogger — rotation", () => {
  it("rotates at maxBytes into .1, .2, ...", async () => {
    const f = scratch();
    const log = createLogger({
      filePath: f,
      maxBytes: 100,
      maxFiles: 3,
      level: "info",
    });
    // Each message JSON is ~60–70 bytes; force 3 rotations quickly.
    for (let i = 0; i < 20; i++) log.info("line", { i });
    log.close();

    expect(fs.existsSync(f)).toBe(true);
    expect(fs.existsSync(`${f}.1`)).toBe(true);
  });
});

describe("redactCommandParams", () => {
  it("replaces sync:authenticate params with [redacted]", () => {
    const params = { datasourceId: "ds-1", intent: { kind: "oauth" } };
    expect(redactCommandParams("sync:authenticate", params)).toBe("[redacted]");
  });

  it("replaces sync:authenticate-start params with [redacted]", () => {
    const params = { datasourceId: "ds-1", type: "amazon-s3" };
    expect(redactCommandParams("sync:authenticate-start", params)).toBe(
      "[redacted]",
    );
  });

  it("replaces sync:authenticate-complete params with [redacted]", () => {
    const params = {
      correlationId: "corr-1",
      completion: { kind: "oauth", code: "secret-code" },
    };
    expect(redactCommandParams("sync:authenticate-complete", params)).toBe(
      "[redacted]",
    );
  });

  it("passes through params for every other command", () => {
    const params = { datasourceId: "ds-1" };
    expect(redactCommandParams("sync:get-job", params)).toBe(params);
  });
});
