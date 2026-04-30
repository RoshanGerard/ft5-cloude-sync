// Type-only fixtures locking in the `as const` object shape of
// `FilesErrorTag` (per add-invalid-datasource-state design.md
// Decision 1) AND asserting the new 5-member shape (the pre-refactor
// 4-member union plus `InvalidDatasource`). Mirrors
// `datasource-error-tag.test-d.ts` for the DatasourceErrorTag refactor.
//
// Existing literal call sites such as `tag === "auth-revoked"` continue
// to type-check because the derived type is the same string union.

import { describe, expect, expectTypeOf, it } from "vitest";

import { FilesErrorTag } from "../files.js";

describe("FilesErrorTag — `as const` object shape (Decision 1)", () => {
  it("exposes a runtime const object with exactly the 8 documented members", () => {
    expect(FilesErrorTag).toStrictEqual({
      AuthRevoked: "auth-revoked",
      Disconnected: "disconnected",
      RateLimited: "rate-limited",
      Other: "other",
      InvalidDatasource: "invalid-datasource",
      Conflict: "conflict",
      Cancelled: "cancelled",
      ExhaustedRetries: "exhausted-retries",
    });
  });

  it("derived type is the documented 8-string union", () => {
    expectTypeOf<FilesErrorTag>().toEqualTypeOf<
      | "auth-revoked"
      | "disconnected"
      | "rate-limited"
      | "other"
      | "invalid-datasource"
      | "conflict"
      | "cancelled"
      | "exhausted-retries"
    >();
  });

  it("const-ref form coexists with pre-refactor literal references", () => {
    // Net-new code uses `FilesErrorTag.InvalidDatasource`; pre-refactor
    // literals such as `"auth-revoked"` keep type-checking unchanged.
    const tagFromConst: FilesErrorTag = FilesErrorTag.InvalidDatasource;
    const tagFromLiteral: FilesErrorTag = "auth-revoked";
    expect(tagFromConst).toBe("invalid-datasource");
    expect(tagFromLiteral).toBe("auth-revoked");
  });

  it("includes Conflict tag for rename collisions (add-engine-rename-download)", () => {
    // `Conflict: "conflict"` is added by add-engine-rename-download for
    // rename's conflictPolicy: "fail" path. The subtype assertion below
    // remains valid even if FilesErrorTag widens further (mirrors
    // DatasourceErrorTag's same-named member at the engine layer).
    expectTypeOf<"conflict">().toMatchTypeOf<FilesErrorTag>();
    const fromConst: FilesErrorTag = FilesErrorTag.Conflict;
    expect(fromConst).toBe("conflict");
  });

  it("includes Cancelled tag for download cancellation (add-engine-rename-download §13)", () => {
    // `Cancelled: "cancelled"` is added by add-engine-rename-download §13
    // for the user-driven `files:download` cancel path (per spec.md
    // "Cancel mid-stream" scenario). Distinct from `"other"` because the
    // renderer's download toaster surfaces cancellation as a soft-state.
    expectTypeOf<"cancelled">().toMatchTypeOf<FilesErrorTag>();
    const fromConst: FilesErrorTag = FilesErrorTag.Cancelled;
    expect(fromConst).toBe("cancelled");
  });

  it("includes ExhaustedRetries tag for environmental retry exhaustion (add-download-resilience)", () => {
    // `ExhaustedRetries: "exhausted-retries"` is added by add-download-resilience
    // for the `files:download` handler's environmental-retry exhaustion paths
    // (consecutive-failure budget exhausted OR wall-time ceiling exceeded).
    // Both exhaustion modes share the same tag; the discriminator (count vs
    // wall-time) lives in the message field as
    // `"exhausted-retries: <engineCause>"` or `"walltime-exceeded: <engineCause>"`.
    expectTypeOf<"exhausted-retries">().toMatchTypeOf<FilesErrorTag>();
    const fromConst: FilesErrorTag = FilesErrorTag.ExhaustedRetries;
    expect(fromConst).toBe("exhausted-retries");
  });
});
