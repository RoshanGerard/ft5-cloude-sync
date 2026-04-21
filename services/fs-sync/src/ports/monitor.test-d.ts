import { describe, expectTypeOf, it } from "vitest";

import type { MonitorChangeEvent, MonitorEventSource } from "./monitor.js";

describe("MonitorEventSource port", () => {
  it("declares the four methods with the expected signatures", () => {
    type Src = MonitorEventSource;
    expectTypeOf<Src["start"]>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<Src["stop"]>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<Src["onChange"]>().parameter(0).parameters.toEqualTypeOf<
      [MonitorChangeEvent]
    >();
  });

  it("MonitorChangeEvent is a discriminated union of five variants", () => {
    type Kinds = MonitorChangeEvent["kind"];
    expectTypeOf<Kinds>().toEqualTypeOf<
      | "file-created"
      | "file-modified"
      | "file-deleted"
      | "source-appeared"
      | "source-disappeared"
    >();
  });
});
