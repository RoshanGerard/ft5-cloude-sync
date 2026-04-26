import { describe, expect, it } from "vitest";

import { DatasourceError } from "@ft5/ipc-contracts";

import { normalizeFilesError } from "./files-error-mapping.js";

describe("normalizeFilesError", () => {
  it("maps auth-revoked DatasourceError 1:1", () => {
    const err = new DatasourceError({
      tag: "auth-revoked",
      datasourceType: "google-drive",
      datasourceId: "ds-1",
      retryable: false,
      message: "refresh token revoked",
    });
    expect(normalizeFilesError(err)).toEqual({
      tag: "auth-revoked",
      message: "refresh token revoked",
      retryable: false,
    });
  });

  it("collapses auth-expired into auth-revoked (from UI's POV both mean reconnect)", () => {
    const err = new DatasourceError({
      tag: "auth-expired",
      datasourceType: "onedrive",
      datasourceId: "ds-2",
      retryable: false,
      message: "token expired",
    });
    expect(normalizeFilesError(err).tag).toBe("auth-revoked");
  });

  it("maps network-error to disconnected", () => {
    const err = new DatasourceError({
      tag: "network-error",
      datasourceType: "amazon-s3",
      datasourceId: "ds-3",
      retryable: true,
      message: "ECONNREFUSED",
    });
    const result = normalizeFilesError(err);
    expect(result.tag).toBe("disconnected");
    expect(result.retryable).toBe(true);
  });

  it("maps rate-limited directly and preserves retryAfterMs when present", () => {
    const err = new DatasourceError({
      tag: "rate-limited",
      datasourceType: "google-drive",
      datasourceId: "ds-4",
      retryable: true,
      retryAfterMs: 30000,
      message: "too many requests",
    });
    expect(normalizeFilesError(err)).toEqual({
      tag: "rate-limited",
      message: "too many requests",
      retryable: true,
      retryAfterMs: 30000,
    });
  });

  it("collapses not-found, conflict, unsupported, provider-error, cancelled into 'other'", () => {
    const tags = [
      "not-found",
      "conflict",
      "unsupported",
      "provider-error",
      "cancelled",
    ] as const;
    for (const tag of tags) {
      const err = new DatasourceError({
        tag,
        datasourceType: "google-drive",
        datasourceId: "ds-x",
        retryable: false,
        message: `simulated ${tag}`,
      });
      expect(normalizeFilesError(err).tag).toBe("other");
      expect(normalizeFilesError(err).message).toBe(`simulated ${tag}`);
    }
  });

  it("maps plain Error to tag:'other' with the message and retryable:false", () => {
    const result = normalizeFilesError(new Error("pipe broken"));
    expect(result).toEqual({
      tag: "other",
      message: "pipe broken",
      retryable: false,
    });
  });

  it("maps a non-Error throw to tag:'other' with stringified value", () => {
    const result = normalizeFilesError("bare string");
    expect(result).toEqual({
      tag: "other",
      message: "bare string",
      retryable: false,
    });
  });

  it("maps invalid-datasource DatasourceError 1:1 (Decision 2)", () => {
    // Per add-invalid-datasource-state §6 — the engine + service-side
    // `resolveClient` choke point throws `DatasourceError({ tag:
    // "invalid-datasource" })` for misconfigured datasources. The
    // envelope tag must surface this as `"invalid-datasource"` (not
    // collapsed to `"other"`) so the renderer's
    // `<InvalidDatasourceState>` and `<InvalidDatasourceBanner>` can
    // render the actionable Reconnect / Remove affordances.
    const err = new DatasourceError({
      tag: "invalid-datasource",
      datasourceType: "google-drive",
      datasourceId: "ds-misconfigured",
      retryable: false,
      message: "Credentials are missing — reconnect this datasource",
    });
    expect(normalizeFilesError(err)).toEqual({
      tag: "invalid-datasource",
      message: "Credentials are missing — reconnect this datasource",
      retryable: false,
    });
  });

  it("non-DatasourceError thrown values still map to 'other' after invalid-datasource branch lands", () => {
    // Regression guard — the new `invalid-datasource` branch must NOT
    // accidentally catch plain throws (Error, string, object). Those
    // continue to surface as `tag: "other"` per the existing contract.
    expect(normalizeFilesError(new Error("pipe broken")).tag).toBe("other");
    expect(normalizeFilesError("bare string").tag).toBe("other");
    expect(normalizeFilesError({ shape: "neither" }).tag).toBe("other");
  });

  it("omits retryAfterMs when the DatasourceError did not carry one", () => {
    const err = new DatasourceError({
      tag: "rate-limited",
      datasourceType: "google-drive",
      datasourceId: "ds-5",
      retryable: true,
      message: "no backoff info",
    });
    const result = normalizeFilesError(err);
    expect("retryAfterMs" in result).toBe(false);
  });
});
