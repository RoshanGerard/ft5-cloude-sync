import type { JobStatus } from "@ft5/ipc-contracts";
import { describe, expect, it } from "vitest";

import {
  IllegalJobTransitionError,
  assertLegalTransition,
  isLegalTransition,
  isTerminal,
} from "./state-machine.js";

const ALL: ReadonlyArray<JobStatus> = [
  "queued",
  "running",
  "waiting-network",
  "completed",
  "failed",
  "cancelled",
];

const LEGAL: ReadonlyArray<[JobStatus, JobStatus]> = [
  ["queued", "running"],
  ["queued", "cancelled"],
  ["running", "waiting-network"],
  ["running", "completed"],
  ["running", "failed"],
  ["running", "cancelled"],
  ["waiting-network", "queued"],
  ["waiting-network", "cancelled"],
];

describe("isLegalTransition", () => {
  it("accepts every spec-listed legal edge", () => {
    for (const [from, to] of LEGAL) {
      expect(isLegalTransition(from, to)).toBe(true);
    }
  });

  it("rejects identity edges (same status)", () => {
    for (const s of ALL) {
      expect(isLegalTransition(s, s)).toBe(false);
    }
  });

  it("rejects every edge out of a terminal status", () => {
    const terminals: ReadonlyArray<JobStatus> = [
      "completed",
      "failed",
      "cancelled",
    ];
    for (const from of terminals) {
      for (const to of ALL) {
        if (from !== to) {
          expect(isLegalTransition(from, to)).toBe(false);
        }
      }
    }
  });

  it("rejects a non-listed edge from queued (e.g., queued → completed)", () => {
    expect(isLegalTransition("queued", "completed")).toBe(false);
    expect(isLegalTransition("queued", "failed")).toBe(false);
    expect(isLegalTransition("queued", "waiting-network")).toBe(false);
  });
});

describe("assertLegalTransition", () => {
  it("throws IllegalJobTransitionError with jobId/from/to on illegal edge", () => {
    try {
      assertLegalTransition("job-1", "queued", "completed");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalJobTransitionError);
      const e = err as IllegalJobTransitionError;
      expect(e.jobId).toBe("job-1");
      expect(e.from).toBe("queued");
      expect(e.to).toBe("completed");
    }
  });

  it("returns quietly on legal edge", () => {
    expect(() => assertLegalTransition("job-1", "queued", "running")).not.toThrow();
  });
});

describe("isTerminal", () => {
  it.each([
    ["completed" as const, true],
    ["failed" as const, true],
    ["cancelled" as const, true],
    ["queued" as const, false],
    ["running" as const, false],
    ["waiting-network" as const, false],
  ])("%s → %s", (status, expected) => {
    expect(isTerminal(status)).toBe(expected);
  });
});
