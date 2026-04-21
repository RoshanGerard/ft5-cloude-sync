import type { Frame } from "@ft5/ipc-contracts/sync-service";
import { describe, expect, it } from "vitest";

import {
  FrameParseError,
  FrameTooLargeError,
  FramingDecoder,
  encodeFrame,
} from "./framing.js";

function captures() {
  const frames: Frame[] = [];
  const errors: (FrameParseError | FrameTooLargeError)[] = [];
  return {
    frames,
    errors,
    events: {
      onFrame: (f: Frame) => frames.push(f),
      onError: (e: FrameParseError | FrameTooLargeError) => errors.push(e),
    },
  };
}

describe("FramingDecoder", () => {
  it("emits each complete newline-delimited frame in order", () => {
    const c = captures();
    const dec = new FramingDecoder(c.events);
    const a = encodeFrame({ kind: "event", name: "a", payload: 1 });
    const b = encodeFrame({ kind: "event", name: "b", payload: 2 });
    dec.push(a + b);
    expect(c.frames.map((f) => (f as { name: string }).name)).toEqual([
      "a",
      "b",
    ]);
    expect(c.errors).toHaveLength(0);
  });

  it("reassembles frames split across multiple pushes at arbitrary byte boundaries", () => {
    const c = captures();
    const dec = new FramingDecoder(c.events);
    const f = encodeFrame({ kind: "event", name: "hello", payload: "world" });
    // Split every 3 bytes.
    for (let i = 0; i < f.length; i += 3) {
      dec.push(f.slice(i, i + 3));
    }
    expect(c.frames).toHaveLength(1);
    expect((c.frames[0] as { name: string }).name).toBe("hello");
  });

  it("accumulates two frames split across three arbitrary chunks", () => {
    const c = captures();
    const dec = new FramingDecoder(c.events);
    const a = encodeFrame({ kind: "event", name: "a", payload: 1 });
    const b = encodeFrame({ kind: "event", name: "b", payload: 2 });
    const combined = a + b;
    const third = Math.floor(combined.length / 3);
    dec.push(combined.slice(0, third));
    dec.push(combined.slice(third, 2 * third));
    dec.push(combined.slice(2 * third));
    expect(c.frames.map((f) => (f as { name: string }).name)).toEqual([
      "a",
      "b",
    ]);
  });

  it("surfaces FrameParseError on malformed JSON, continues decoding the next frame", () => {
    const c = captures();
    const dec = new FramingDecoder(c.events);
    dec.push("not-json\n");
    const f = encodeFrame({ kind: "event", name: "ok", payload: 1 });
    dec.push(f);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]).toBeInstanceOf(FrameParseError);
    expect(c.frames.map((fr) => (fr as { name: string }).name)).toEqual(["ok"]);
  });

  it("tolerates blank lines", () => {
    const c = captures();
    const dec = new FramingDecoder(c.events);
    dec.push("\n\n");
    dec.push(encodeFrame({ kind: "event", name: "x", payload: null }));
    expect(c.frames).toHaveLength(1);
    expect(c.errors).toHaveLength(0);
  });

  it("surfaces FrameTooLargeError when a single frame exceeds the cap", () => {
    const c = captures();
    const dec = new FramingDecoder(c.events, { maxFrameBytes: 64 });
    const big = "x".repeat(200);
    dec.push(`${big}\n`);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]).toBeInstanceOf(FrameTooLargeError);
  });

  it("surfaces FrameTooLargeError for an in-progress (unterminated) oversized buffer", () => {
    const c = captures();
    const dec = new FramingDecoder(c.events, { maxFrameBytes: 64 });
    dec.push("x".repeat(200)); // no newline yet
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]).toBeInstanceOf(FrameTooLargeError);
    expect(dec.pendingBytes()).toBe(0); // buffer cleared on reject
  });
});

describe("encodeFrame", () => {
  it("produces exactly one newline-terminated JSON line", () => {
    const out = encodeFrame({ kind: "event", name: "x", payload: 1 });
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n")).toHaveLength(2);
  });

  it("does not silently encode a circular reference", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(() =>
      encodeFrame({ kind: "event", name: "x", payload: cycle }),
    ).toThrow();
  });
});
