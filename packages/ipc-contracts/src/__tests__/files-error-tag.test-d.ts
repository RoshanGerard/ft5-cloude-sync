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
  it("exposes a runtime const object with exactly the 6 documented members", () => {
    expect(FilesErrorTag).toStrictEqual({
      AuthRevoked: "auth-revoked",
      Disconnected: "disconnected",
      RateLimited: "rate-limited",
      Other: "other",
      InvalidDatasource: "invalid-datasource",
      Conflict: "conflict",
    });
  });

  it("derived type is the documented 6-string union", () => {
    expectTypeOf<FilesErrorTag>().toEqualTypeOf<
      | "auth-revoked"
      | "disconnected"
      | "rate-limited"
      | "other"
      | "invalid-datasource"
      | "conflict"
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
});
