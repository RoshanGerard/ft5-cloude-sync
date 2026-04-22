// Bootstrap ordering observer test. Boots the service against a scratch
// data dir with a deterministic `BootstrapObserver` spy, then asserts the
// exact sequence of stages fired during startup matches the 11-step order
// mandated by the wire-fs-sync-service spec (see
// openspec/changes/wire-fs-sync-service/specs/fs-sync-service/spec.md —
// "Bootstrap order is observable" scenario, expanded by tasks.md 2.1).

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrap,
  type BootstrapStage,
  type Runtime,
} from "./bootstrap.js";

let scratchDir: string;
let runtime: Runtime | null = null;

function pipeFor(tag: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-boot-${tag}-${suffix}`;
  }
  return path.join(os.tmpdir(), `ft5-sync-boot-${tag}-${suffix}.sock`);
}

beforeEach(async () => {
  scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ft5-sync-bootstrap-"));
  runtime = null;
});

afterEach(async () => {
  try {
    if (runtime) await runtime.stop();
  } finally {
    runtime = null;
    try {
      await fsp.rm(scratchDir, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
});

describe("bootstrap ordering", () => {
  it("fires the 11 bootstrap stages in the spec-mandated order", async () => {
    const observed: BootstrapStage[] = [];
    const pipePath = pipeFor("order");

    runtime = await bootstrap({
      dev: true,
      pathOverrides: {
        dataDir: scratchDir,
        pidPath: path.join(scratchDir, "service-dev.pid"),
        dbPath: path.join(scratchDir, "sync.db"),
        socketPath: pipePath,
        credentialsPath: path.join(scratchDir, "credentials.json"),
      },
      observer: {
        onStage(stage) {
          observed.push(stage);
        },
      },
    });

    // The test-level assertion: every stage fires exactly once, in order.
    const expected: BootstrapStage[] = [
      "open-database",
      "apply-migrations",
      "integrity-ok",
      "acquire-pid-guard",
      "construct-credential-store",
      "construct-provider-registry",
      "construct-client-factory",
      "construct-scheduler",
      "construct-network-probe",
      "recover-running-jobs",
      "ipc-listen",
    ];
    expect(observed).toEqual(expected);

    // IPC listen is the LAST observable side-effect before the runtime is
    // returned — sanity-check the pipePath surface.
    expect(runtime.pipePath).toBe(pipePath);
  });

  it("settles stop() without leaking timers when no jobs are queued", async () => {
    runtime = await bootstrap({
      dev: true,
      pathOverrides: {
        dataDir: scratchDir,
        pidPath: path.join(scratchDir, "service-dev.pid"),
        dbPath: path.join(scratchDir, "sync.db"),
        socketPath: pipeFor("stop"),
        credentialsPath: path.join(scratchDir, "credentials.json"),
      },
    });

    const t0 = Date.now();
    await runtime.stop();
    runtime = null;
    const elapsed = Date.now() - t0;
    // Stop should be near-instant with an idle scheduler + disarmed probe.
    expect(elapsed).toBeLessThan(2_000);
  });
});
