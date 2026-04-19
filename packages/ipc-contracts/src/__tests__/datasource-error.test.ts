import { describe, expect, it } from "vitest";

import { DatasourceError } from "../fs-datasource-engine.js";

describe("DatasourceError — construction + shape", () => {
  it("is a subclass of Error and DatasourceError (instanceof both)", () => {
    const err = new DatasourceError({
      tag: "not-found",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatasourceError);
  });

  it("copies every required init field onto the instance", () => {
    const err = new DatasourceError({
      tag: "rate-limited",
      datasourceType: "google-drive",
      datasourceId: "ds-gdrive-7",
      retryable: true,
      retryAfterMs: 1500,
      raw: { code: 429, message: "Too Many Requests" },
      message: "slow down",
    });
    expect(err.tag).toBe("rate-limited");
    expect(err.datasourceType).toBe("google-drive");
    expect(err.datasourceId).toBe("ds-gdrive-7");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(1500);
    expect(err.raw).toEqual({ code: 429, message: "Too Many Requests" });
    expect(err.message).toBe("slow down");
    expect(err.name).toBe("DatasourceError");
  });

  it("omits optional fields when not supplied", () => {
    const err = new DatasourceError({
      tag: "unsupported",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
    });
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.raw).toBeUndefined();
    // exactOptionalPropertyTypes: `retryAfterMs` absent rather than === undefined
    expect("retryAfterMs" in err).toBe(false);
    expect("raw" in err).toBe(false);
  });

  it("falls back to a deterministic message when one is not supplied", () => {
    const err = new DatasourceError({
      tag: "auth-expired",
      datasourceType: "onedrive",
      datasourceId: "ds-od-3",
      retryable: false,
    });
    expect(err.message).toContain("auth-expired");
    expect(err.message).toContain("onedrive");
    expect(err.message).toContain("ds-od-3");
  });

  it("supports every tag in the 8-tag taxonomy without runtime error", () => {
    const tags = [
      "auth-expired",
      "auth-revoked",
      "not-found",
      "conflict",
      "unsupported",
      "rate-limited",
      "network-error",
      "provider-error",
    ] as const;
    for (const tag of tags) {
      const err = new DatasourceError({
        tag,
        datasourceType: "amazon-s3",
        datasourceId: "ds-x",
        retryable: tag === "rate-limited" || tag === "network-error",
      });
      expect(err.tag).toBe(tag);
    }
  });

  it("preserves a usable stack trace", () => {
    const err = new DatasourceError({
      tag: "provider-error",
      datasourceType: "amazon-s3",
      datasourceId: "ds-1",
      retryable: false,
    });
    expect(typeof err.stack).toBe("string");
    expect(err.stack?.length ?? 0).toBeGreaterThan(0);
  });
});
