import { describe, expectTypeOf, it } from "vitest";

import type {
  ErrorShape,
  EventFrame,
  Frame,
  RequestFrame,
  ResponseFrame,
} from "./frames.js";

describe("sync-service frames", () => {
  it("RequestFrame has the documented shape", () => {
    expectTypeOf<RequestFrame>().toEqualTypeOf<{
      readonly id: string;
      readonly kind: "request";
      readonly command: string;
      readonly params: unknown;
    }>();
  });

  it("ResponseFrame is a discriminated union on `ok`", () => {
    expectTypeOf<ResponseFrame>().toEqualTypeOf<
      | {
          readonly id: string;
          readonly kind: "response";
          readonly ok: true;
          readonly result: unknown;
        }
      | {
          readonly id: string;
          readonly kind: "response";
          readonly ok: false;
          readonly error: ErrorShape;
        }
    >();
  });

  it("EventFrame has the documented shape", () => {
    expectTypeOf<EventFrame>().toEqualTypeOf<{
      readonly kind: "event";
      readonly name: string;
      readonly payload: unknown;
    }>();
  });

  it("Frame is the union of the three frame kinds discriminated by `kind`", () => {
    expectTypeOf<Frame>().toEqualTypeOf<
      RequestFrame | ResponseFrame | EventFrame
    >();
  });

  it("ErrorShape has the documented shape", () => {
    expectTypeOf<ErrorShape>().toEqualTypeOf<{
      readonly tag: string;
      readonly message: string;
      readonly details?: unknown;
    }>();
  });
});
