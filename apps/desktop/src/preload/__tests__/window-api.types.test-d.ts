import { describe, expectTypeOf, it } from "vitest";

import type {
  AnyDatasourceEvent,
  ConsentEvent,
  DatasourcesCancelConsentRequest,
  DatasourcesCancelConsentResponse,
  DatasourcesStartConsentRequest,
  DatasourcesStartConsentResponse,
} from "@ft5/ipc-contracts";
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
// add-drive-oauth-browser-consent — Group 2 task 2.1
// Asserts symmetric presence of startConsent / cancelConsent on
// `window.api.datasources` with the exact contract types. Paired with the
// `DatasourcesStartConsentRequest` / `Response` type checks in
// `packages/ipc-contracts/src/__tests__/datasources.test-d.ts` — here we
// verify the surface binding, there we verify the contract types themselves.
// ---------------------------------------------------------------------------

type DatasourcesSurface = Window["api"]["datasources"];

describe("window.api.datasources consent surface (task 2.1)", () => {
  it("window.api.datasources is NOT any (guard: catches missing datasources declaration)", () => {
    expectTypeOf<DatasourcesSurface>().not.toBeAny();
  });

  it("window.api.datasources.startConsent has the contract request/response shape", () => {
    expectTypeOf<DatasourcesSurface["startConsent"]>().toEqualTypeOf<
      (
        req: DatasourcesStartConsentRequest,
      ) => Promise<DatasourcesStartConsentResponse>
    >();
  });

  it("window.api.datasources.cancelConsent returns Promise<void>", () => {
    expectTypeOf<DatasourcesSurface["cancelConsent"]>().toEqualTypeOf<
      (
        req: DatasourcesCancelConsentRequest,
      ) => Promise<DatasourcesCancelConsentResponse>
    >();
    // Explicit: the IPC-handler-wrapped response is Promise<void>.
    expectTypeOf<DatasourcesSurface["cancelConsent"]>().returns.toEqualTypeOf<
      Promise<void>
    >();
  });

  // Spec: "Consent events flow through the existing onEvent stream"
  // (datasources-ui delta). Callback's event parameter must accept every
  // ConsentEvent variant, not just AnyDatasourceEvent.
  it("window.api.datasources.onEvent accepts ConsentEvent variants", () => {
    expectTypeOf<DatasourcesSurface["onEvent"]>().toEqualTypeOf<
      (cb: (event: AnyDatasourceEvent | ConsentEvent) => void) => () => void
    >();
  });
});
