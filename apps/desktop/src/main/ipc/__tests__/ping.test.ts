import { describe, expect, it } from "vitest";
import { handlePing } from "../ping";

describe("handlePing", () => {
  it("returns { ok: true, ts: <now-ish> }", () => {
    const before = Date.now();
    const result = handlePing();
    const after = Date.now();

    expect(result).toEqual({
      ok: true,
      ts: expect.any(Number),
    });
    expect(result.ok).toBe(true);
    // `ts` is a fresh millisecond timestamp. Bracket it by the surrounding
    // wall-clock reads plus a generous ±2000ms tolerance so a slow CI tick
    // cannot flake the assertion.
    expect(result.ts).toBeGreaterThanOrEqual(before - 2000);
    expect(result.ts).toBeLessThanOrEqual(after + 2000);
  });
});
