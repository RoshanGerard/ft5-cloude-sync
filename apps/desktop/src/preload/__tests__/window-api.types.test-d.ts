import { describe, expectTypeOf, it } from "vitest";

import type { AnyDatasourceEvent } from "@ft5/ipc-contracts";
import type {
  SyncEvent,
  SyncListJobsResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

// Type-level test for the window.api.sync branch declared in window-api.d.ts.
//
// These assertions run as part of Vitest's typecheck pass (`tsc`-backed) using
// apps/desktop/tsconfig.test.json which includes window-api.d.ts directly —
// that fires the `declare global { interface Window { api: ... } }` augmentation
// into the tsc program without needing an import.
//
// The tsconfig.test.json is referenced from vitest.config.ts typecheck.tsconfig
// so that the apps/desktop/tsconfig.json `exclude: ["src/**/__tests__/**"]`
// rule does not silently exclude this file and make all assertions vacuous.
//
// Reference: packages/ipc-contracts/src/sync-service-desktop/channels.test-d.ts
// for the established `expectTypeOf` / `toEqualTypeOf` pattern in this repo.

type SyncSurface = Window["api"]["sync"];

describe("window.api.sync type declarations", () => {
  it("window.api.sync is NOT any (guard: catches missing sync declaration)", () => {
    // When the `sync` block is absent from window-api.d.ts, Window["api"]["sync"]
    // resolves to `any` (TypeScript's fallback for missing property access on an
    // augmented interface). All subsequent toEqualTypeOf assertions would then
    // pass vacuously. This guard test FAILS in that case, making the missing
    // declaration detectable.
    expectTypeOf<SyncSurface>().not.toBeAny();
  });

  it("window.api.sync.listJobs has return type Promise<SyncListJobsResponse>", () => {
    expectTypeOf<SyncSurface["listJobs"]>().returns.toEqualTypeOf<
      Promise<SyncListJobsResponse>
    >();
  });

  it("window.api.sync.onEvent has signature (cb: (event: SyncEvent) => void) => () => void", () => {
    expectTypeOf<SyncSurface["onEvent"]>().toEqualTypeOf<
      (cb: (event: SyncEvent) => void) => () => void
    >();
  });

  it("window.api.sync.getStatus has return type Promise<...> with no required args", () => {
    // getStatus is the void-request method — it takes no parameters
    expectTypeOf<SyncSurface["getStatus"]>().parameters.toEqualTypeOf<[]>();
  });

  it("authenticate (legacy) is NOT present on window.api.sync", () => {
    // The dormant legacy key must not appear in the type declaration.
    // This compile-time check verifies "authenticate" is not a key of SyncSurface.
    expectTypeOf<keyof SyncSurface>().not.toEqualTypeOf<"authenticate">();
  });
});

// ---------------------------------------------------------------------------
// implement-datasource-onboarding §19 + spec scenario "startConsent and
// cancelConsent are absent from the surface". The renderer migrates fully
// to `window.api.sync.authenticateStart` / `authenticateCancel` for the
// authenticate flow (per design.md Decision 3); the desktop's datasources
// surface no longer carries `startConsent` / `cancelConsent` keys.
// ---------------------------------------------------------------------------

type DatasourcesSurface = Window["api"]["datasources"];

describe("window.api.datasources surface (post-§19)", () => {
  it("window.api.datasources is NOT any (guard: catches missing datasources declaration)", () => {
    expectTypeOf<DatasourcesSurface>().not.toBeAny();
  });

  it("startConsent is absent from window.api.datasources", () => {
    // After §19, the surface no longer carries `startConsent`. A compile-
    // time absence assertion catches accidental re-additions.
    expectTypeOf<keyof DatasourcesSurface>().not.toEqualTypeOf<"startConsent">();
  });

  it("cancelConsent is absent from window.api.datasources", () => {
    expectTypeOf<keyof DatasourcesSurface>().not.toEqualTypeOf<"cancelConsent">();
  });

  it("onEvent only receives AnyDatasourceEvent (consent variants moved to sync.onEvent)", () => {
    // Authentication lifecycle events (auth-*) flow exclusively on the sync
    // event stream now per design Decision 7. The datasources onEvent
    // callback's parameter is plain `AnyDatasourceEvent` with no
    // `| ConsentEvent` widening.
    expectTypeOf<DatasourcesSurface["onEvent"]>().toEqualTypeOf<
      (cb: (event: AnyDatasourceEvent) => void) => () => void
    >();
  });
});
