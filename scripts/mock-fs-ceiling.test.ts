import { describe, expect, it } from "vitest";

import { enumerateSeededDirectorySizes } from "../apps/desktop/src/main/ipc/files/mock-fs.js";

// Guardrail for design.md Decision 10: every seeded directory in the v1 mock
// file system stays at or below 300 entries. This test is the canary — a
// contributor cannot quietly 10x the fixture without lighting this up.
const DIRECTORY_SIZE_CEILING = 300;

describe("mock-fs directory-size ceiling", () => {
  it("every seeded directory is at or below the ceiling", () => {
    const sizes = enumerateSeededDirectorySizes();
    expect(sizes.length).toBeGreaterThan(0);
    for (const { datasourceId, path, size } of sizes) {
      expect(
        size <= DIRECTORY_SIZE_CEILING,
        `seeded directory ${datasourceId}:${path} has ${String(size)} entries (max ${String(DIRECTORY_SIZE_CEILING)})`,
      ).toBe(true);
    }
  });
});
