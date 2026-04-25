// Type-only fixtures locking in the `as const` object shape of
// `DatasourceErrorTag` (per add-invalid-datasource-state design.md
// Decision 1) AND asserting that the 9 pre-refactor string-literal
// call sites continue to type-check after the refactor — the derived
// type is the same string union, so existing literal references are
// not migrated by this change (Decision 1, alternatives "Migrate all"
// rejected).
//
// This file is consumed by vitest via the `*.test-d.ts` typecheck path
// (vitest --typecheck). Pure type-equality + a single value-level
// assertion that the const object members match their literal values.

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DatasourceError,
  DatasourceErrorTag,
} from "../fs-datasource-engine.js";

describe("DatasourceErrorTag — `as const` object shape (Decision 1)", () => {
  it("exposes a runtime const object with exactly the 10 documented members", () => {
    // Snapshot of expected literal values. `InvalidDatasource` joins in
    // §3 of add-invalid-datasource-state and is the engine-side tag for
    // misconfigured datasources (registry drift, missing credential file,
    // wrong credential shape).
    expect(DatasourceErrorTag).toStrictEqual({
      AuthExpired: "auth-expired",
      AuthRevoked: "auth-revoked",
      NotFound: "not-found",
      Conflict: "conflict",
      Unsupported: "unsupported",
      RateLimited: "rate-limited",
      NetworkError: "network-error",
      ProviderError: "provider-error",
      Cancelled: "cancelled",
      InvalidDatasource: "invalid-datasource",
    });
  });

  it("derived type is the same 10-string union as the documented taxonomy", () => {
    // Equality check: derived type from `as const` matches the documented
    // union so pre-refactor literal call sites continue to type-check
    // without migration.
    expectTypeOf<DatasourceErrorTag>().toEqualTypeOf<
      | "auth-expired"
      | "auth-revoked"
      | "not-found"
      | "conflict"
      | "unsupported"
      | "rate-limited"
      | "network-error"
      | "provider-error"
      | "cancelled"
      | "invalid-datasource"
    >();
  });

  it("DatasourceError accepts the const-ref form for tag", () => {
    // Net-new code uses `DatasourceErrorTag.AuthExpired` directly.
    const err = new DatasourceError({
      tag: DatasourceErrorTag.AuthExpired,
      datasourceType: "google-drive",
      datasourceId: "ds-1",
      retryable: false,
    });
    expect(err.tag).toBe("auth-expired");
  });

  it("DatasourceError accepts the pre-refactor literal form for tag (no migration required)", () => {
    // 143+ existing literal references in the codebase keep working
    // because the derived type IS the string union.
    const err = new DatasourceError({
      tag: "auth-revoked",
      datasourceType: "onedrive",
      datasourceId: "ds-2",
      retryable: false,
    });
    expect(err.tag).toBe("auth-revoked");
  });
});
