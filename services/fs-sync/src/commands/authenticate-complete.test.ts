// Tests for the stubbed `sync:authenticate-complete` handler. Mirrors the
// shape of `authenticate-start.test.ts`: stub returns a not-implemented
// error regardless of params and never touches the correlation store.
// Real implementation is deferred to the follow-up
// `implement-datasource-onboarding` change per openspec design.md
// Decision 11.

import { describe, expect, it } from "vitest";

import type { Connection } from "../ipc/server.js";

import { handleAuthenticateComplete } from "./authenticate-complete.js";

function ctx(): { readonly connection: Connection } {
  return {
    connection: {
      id: 1,
      closed: false,
      sendEvent: () => void 0,
    },
  };
}

describe("sync:authenticate-complete handler (stub)", () => {
  it("returns not-implemented for an oauth completion", async () => {
    const res = await handleAuthenticateComplete(
      {
        correlationId: "any-id",
        completion: { kind: "oauth", code: "auth-code-xyz" },
      },
      ctx(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("not-implemented");
    if (res.error.tag !== "not-implemented") return;
    expect(typeof res.error.message).toBe("string");
    expect(res.error.message.length).toBeGreaterThan(0);
    expect(res.error.message.toLowerCase()).toMatch(
      /pending follow-up|design\.md|decision 11/,
    );
  });

  it("returns not-implemented for a credentials-form completion", async () => {
    const res = await handleAuthenticateComplete(
      {
        correlationId: "any-id",
        completion: {
          kind: "credentials-form",
          values: { accessKeyId: "AKIA...", secretAccessKey: "sec" },
        },
      },
      ctx(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("not-implemented");
  });

  it("does not look up the correlation id (no correlation-store dep)", async () => {
    // Passing a correlation id that would otherwise resolve to
    // correlation-expired proves no lookup happens: the response tag is
    // not-implemented, not correlation-expired.
    const res = await handleAuthenticateComplete(
      {
        correlationId: "nonexistent-correlation-id-that-would-fail-lookup",
        completion: { kind: "oauth", code: "any" },
      },
      ctx(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("not-implemented");
    expect(res.error.tag).not.toBe("correlation-expired");
  });

  it("is pure: two successive calls return structurally equal responses", async () => {
    const a = await handleAuthenticateComplete(
      { correlationId: "x", completion: { kind: "oauth", code: "c" } },
      ctx(),
    );
    const b = await handleAuthenticateComplete(
      { correlationId: "x", completion: { kind: "oauth", code: "c" } },
      ctx(),
    );
    expect(a).toEqual(b);
  });
});
