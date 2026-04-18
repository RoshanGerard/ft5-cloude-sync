import { describe, expect, expectTypeOf, it } from "vitest";

import type { PingRequest, PingResponse } from "../index.js";

describe("ipc-contracts ping types", () => {
  it("PingRequest is void", () => {
    expectTypeOf<PingRequest>().toEqualTypeOf<void>();
  });

  it("PingResponse is { ok: true; ts: number }", () => {
    expectTypeOf<PingResponse>().toEqualTypeOf<{ ok: true; ts: number }>();
  });

  it("PingResponse can be constructed with ok=true and numeric ts", () => {
    // Runtime sanity so Vitest actually executes an assertion against a value
    // that has to satisfy the declared PingResponse shape. A pure type-only
    // test has no runtime behaviour and would register zero tests.
    const sample: PingResponse = { ok: true, ts: Date.now() };
    expect(sample.ok).toBe(true);
    expect(typeof sample.ts).toBe("number");
  });
});
