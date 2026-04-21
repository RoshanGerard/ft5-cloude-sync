import { describe, expect, it } from "vitest";

import { classifySystemRetry } from "./system-retry.js";

describe("classifySystemRetry", () => {
  it("network-error → waiting-network", () => {
    const r = classifySystemRetry("network-error");
    expect(r.branch).toBe("waiting-network");
  });

  it("rate-limited with retryAfterMs → retry-after with that delay", () => {
    const r = classifySystemRetry("rate-limited", 1234);
    expect(r).toEqual({ branch: "retry-after", retryAfterMs: 1234 });
  });

  it("rate-limited without retryAfterMs → retry-after with default 5000ms", () => {
    const r = classifySystemRetry("rate-limited");
    expect(r).toEqual({ branch: "retry-after", retryAfterMs: 5000 });
  });

  it("auth-expired → terminal (engine handles; passthrough to user-retry)", () => {
    const r = classifySystemRetry("auth-expired");
    expect(r.branch).toBe("terminal");
  });

  it.each([
    "provider-error",
    "auth-revoked",
    "not-found",
    "conflict",
    "unsupported",
  ])("%s → terminal", (tag) => {
    expect(classifySystemRetry(tag).branch).toBe("terminal");
  });
});
