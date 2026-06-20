// Type-only + runtime fixtures locking in the `as const` object shape of
// `EntryKind` (per unify-engine-delete-method design.md Decision 3).
// Mirrors `files-error-tag.test-d.ts`. The derived type stays the same
// two-string union, so existing literal references such as `kind === "file"`
// keep type-checking unchanged (non-breaking).

import { describe, expect, expectTypeOf, it } from "vitest";

import { EntryKind } from "../files.js";

describe("EntryKind — `as const` object shape (unify-engine-delete-method Decision 3)", () => {
  it("exposes a runtime const object with exactly the 2 documented members", () => {
    expect(EntryKind).toStrictEqual({
      Directory: "directory",
      File: "file",
    });
  });

  it("derived type is the documented 2-string union", () => {
    expectTypeOf<EntryKind>().toEqualTypeOf<"directory" | "file">();
  });

  it("const-ref form coexists with pre-refactor literal references", () => {
    // Net-new code uses `EntryKind.File` / `EntryKind.Directory`;
    // pre-refactor literals such as `"file"` keep type-checking unchanged.
    const kindFromConst: EntryKind = EntryKind.File;
    const kindFromLiteral: EntryKind = "directory";
    expect(kindFromConst).toBe("file");
    expect(kindFromLiteral).toBe("directory");
  });
});
