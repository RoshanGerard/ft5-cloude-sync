// Tests for the stubbed `sync:authenticate-start` handler. This handler
// is intentionally a no-op returning `{ ok: false, error: { tag:
// "not-implemented", ... } }` — the real service-side authenticate flow is
// deferred to the follow-up `implement-datasource-onboarding` change per
// openspec design.md Decision 11.
//
// Because the stub has no dependencies (no correlation store, no engine,
// no factory), we import the handler directly and call it with a
// minimal ctx matching `CommandHandler<"sync:authenticate-start">`.

import { describe, expect, it } from "vitest";

import type { Connection } from "../ipc/server.js";

import { handleAuthenticateStart } from "./authenticate-start.js";

function ctx(): { readonly connection: Connection } {
  return {
    connection: {
      id: 1,
      closed: false,
      sendEvent: () => void 0,
    },
  };
}

describe("sync:authenticate-start handler (stub)", () => {
  it("returns not-implemented for amazon-s3 input", async () => {
    const res = await handleAuthenticateStart(
      { datasourceId: "ds-1", type: "amazon-s3" },
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

  it("returns not-implemented for google-drive input", async () => {
    const res = await handleAuthenticateStart(
      { datasourceId: "ds-2", type: "google-drive" },
      ctx(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("not-implemented");
  });

  it("returns not-implemented for onedrive input", async () => {
    const res = await handleAuthenticateStart(
      { datasourceId: "ds-3", type: "onedrive" },
      ctx(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.tag).toBe("not-implemented");
  });

  it("is pure: two successive calls return structurally equal responses", async () => {
    const a = await handleAuthenticateStart(
      { datasourceId: "ds-x", type: "amazon-s3" },
      ctx(),
    );
    const b = await handleAuthenticateStart(
      { datasourceId: "ds-x", type: "amazon-s3" },
      ctx(),
    );
    expect(a).toEqual(b);
  });
});
