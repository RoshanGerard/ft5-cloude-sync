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

  it("collapses not-found, unsupported, provider-error, cancelled into 'other' (conflict has its own tag — see test below)", () => {
    const tags = [
      "not-found",
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

  it("conflict surfaces as tag:'conflict' with existingPath threaded from raw (add-engine-rename-download Decision 7)", () => {
    // Per design.md Decision 7 + spec.md "Rename conflict re-prompts via
    // ConflictResolutionDialog": the wire-layer envelope MUST carry both
    // `tag: "conflict"` and the colliding sibling path on `existingPath`
    // so the renderer's dialog can prompt the user with the exact path.
    // The engine puts the path on `DatasourceError.raw = { existingPath }`.
    const err = new DatasourceError({
      tag: "conflict",
      datasourceType: "google-drive",
      datasourceId: "ds-1",
      retryable: false,
      raw: { existingPath: "/parent/bar.pdf" },
      message: "name already exists at /parent/bar.pdf",
    });
    const result = normalizeFilesError(err);
    expect(result.tag).toBe("conflict");
    expect(result.message).toBe("name already exists at /parent/bar.pdf");
    expect(result.retryable).toBe(false);
    expect(result.existingPath).toBe("/parent/bar.pdf");
  });

  it("conflict without raw.existingPath omits the field (defensive shape preservation)", () => {
    // If the engine ever throws a conflict-tagged error WITHOUT the
    // expected `raw.existingPath` shape, the wire layer surfaces the tag
    // but omits the existingPath field — flat-optional, mirroring
    // retryAfterMs.
    const err = new DatasourceError({
      tag: "conflict",
      datasourceType: "google-drive",
      datasourceId: "ds-1",
      retryable: false,
      message: "conflict without raw payload",
    });
    const result = normalizeFilesError(err);
    expect(result.tag).toBe("conflict");
    expect("existingPath" in result).toBe(false);
  });

  it("conflict with non-object raw (defensive — string raw) omits existingPath", () => {
    const err = new DatasourceError({
      tag: "conflict",
      datasourceType: "google-drive",
      datasourceId: "ds-1",
      retryable: false,
      raw: "opaque-provider-string",
      message: "conflict with opaque raw",
    });
    const result = normalizeFilesError(err);
    expect(result.tag).toBe("conflict");
    expect("existingPath" in result).toBe(false);
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

  it("substitutes a friendly message when a DatasourceError carries Drive's fileNotDownloadable reason (post-archive Docs-Editors fallback)", () => {
    // Defence-in-depth (post-archive smoke 2026-04-28): if the engine's
    // upstream Google Apps detection misses (e.g. a future subtype),
    // the alt=media 403 surfaces here as a `provider-error` carrying
    // the raw Google JSON in the message. The JSON includes the
    // documented reason `fileNotDownloadable`. Detect either signature
    // and substitute a friendly message; the tag still collapses to
    // "other" per the existing mapping.
    const rawJson = JSON.stringify({
      error: {
        code: 403,
        message:
          "Only files with binary content can be downloaded. Use Export with Docs Editors files.",
        errors: [{ reason: "fileNotDownloadable" }],
      },
    });
    const err = new DatasourceError({
      tag: "provider-error",
      datasourceType: "google-drive",
      datasourceId: "ds-docs-fallback",
      retryable: false,
      message: rawJson,
    });
    const result = normalizeFilesError(err);
    expect(result.tag).toBe("other");
    expect(result.message).toContain(
      "Google Doc, Sheet, or Slide",
    );
    expect(result.message).toContain("add-drive-docs-editors-export");
    // The raw JSON noise should not leak through to the renderer.
    expect(result.message).not.toContain("fileNotDownloadable");
  });

  it("substitutes friendly message when the DatasourceError message contains the Drive 'Use Export with Docs Editors files' phrase (alternate signature)", () => {
    const err = new DatasourceError({
      tag: "provider-error",
      datasourceType: "google-drive",
      datasourceId: "ds-docs-fallback-2",
      retryable: false,
      message:
        "Drive said: Only files with binary content can be downloaded. Use Export with Docs Editors files.",
    });
    const result = normalizeFilesError(err);
    expect(result.message).toContain(
      "Google Doc, Sheet, or Slide",
    );
  });

  it("substitutes friendly message even for plain Error throws that embed the Drive Docs-Editors signature (non-DatasourceError fallback)", () => {
    // The engine normalizes most thrown values into DatasourceError;
    // this case guards against a raw provider error escaping the
    // normalizer (e.g. the value gets `JSON.stringify`-ed at a higher
    // layer). The message still gets the friendly substitution.
    const err = new Error('{"reason":"fileNotDownloadable"}');
    const result = normalizeFilesError(err);
    expect(result.tag).toBe("other");
    expect(result.message).toContain(
      "Google Doc, Sheet, or Slide",
    );
  });

  it("does NOT substitute when the message is a benign DatasourceError message (regression guard for the substitution)", () => {
    const err = new DatasourceError({
      tag: "auth-revoked",
      datasourceType: "google-drive",
      datasourceId: "ds-1",
      retryable: false,
      message: "refresh token revoked",
    });
    const result = normalizeFilesError(err);
    expect(result.message).toBe("refresh token revoked");
    expect(result.message).not.toContain("Google Doc");
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
