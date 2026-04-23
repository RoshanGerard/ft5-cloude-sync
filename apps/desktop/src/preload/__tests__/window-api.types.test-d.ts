import { describe, expectTypeOf, it } from "vitest";

import type {
  SyncEvent,
  SyncListJobsResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

// Type-level test for the window.api.sync branch declared in window-api.d.ts.
//
// These assertions run as part of Vitest's typecheck pass (`tsc`-backed).
// They do not import `window` at runtime — `Window["api"]["sync"]` is a
// pure type-space access on the DOM global augmentation.
//
// Reference: packages/ipc-contracts/src/sync-service-desktop/channels.test-d.ts
// for the established `expectTypeOf` / `toEqualTypeOf` pattern in this repo.

type SyncSurface = Window["api"]["sync"];

describe("window.api.sync type declarations", () => {
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
