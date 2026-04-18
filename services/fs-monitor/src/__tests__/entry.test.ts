import { describe, expect, it } from "vitest";

import { start } from "../index";

describe("fs-monitor entry", () => {
  it("exports a start function", () => {
    expect(typeof start).toBe("function");
  });

  it("start() is a no-op that returns { started: true }", () => {
    expect(start()).toEqual({ started: true });
  });
});
