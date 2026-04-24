import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// This is a FILESYSTEM test — it reads the preload source as raw text and
// greps for forbidden imports. A module-level import test would either
// succeed (allowed) or fail with a resolution error rather than a clean
// assertion failure. Raw text greping gives a clear, actionable failure
// message if someone accidentally imports from the wire subpath.
//
// Scope:
//   ALLOWED:  `@ft5/ipc-contracts` (root barrel — existing datasources/files/ping)
//   ALLOWED:  `@ft5/ipc-contracts/sync-service-desktop` (renderer-facing subpath)
//   FORBIDDEN: `@ft5/ipc-contracts/sync-service` (wire subpath, reserved for
//              main ↔ service daemon; the renderer and preload must never see
//              wire-format types like RequestFrame / Frame)
//   FORBIDDEN: `@ft5/ipc-contracts/sync-service/<anything>` (sub-paths of the wire)

const PRELOAD_PATH = resolve(
  __dirname,
  "..",
  "index.ts",
);

describe("preload import-boundary: sync-service wire subpath must not be imported", () => {
  it("preload/index.ts does not import from @ft5/ipc-contracts/sync-service", () => {
    const source = readFileSync(PRELOAD_PATH, "utf8");

    // Match `sync-service` as a complete path segment: it must be followed by
    // `"`, `'`, or `/` (a sub-path). The negative-lookahead `(?!-desktop)`
    // ensures we do NOT accidentally match the ALLOWED `sync-service-desktop`.
    //
    // Pattern breakdown:
    //   @ft5/ipc-contracts/sync-service  — the forbidden prefix
    //   (?!-desktop)                     — NOT followed by -desktop
    //   ["'/]                            — must be followed by quote or slash
    //                                      (completes the path segment or ends
    //                                       the string literal)
    const forbiddenPattern = /@ft5\/ipc-contracts\/sync-service(?!-desktop)["'/]/g;

    const matches = source.match(forbiddenPattern);

    expect(
      matches,
      `preload/index.ts must not import from the wire subpath @ft5/ipc-contracts/sync-service. ` +
        `Found forbidden pattern(s): ${JSON.stringify(matches)}`,
    ).toBeNull();
  });
});
