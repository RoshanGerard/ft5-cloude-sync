// sync-client-holder tests.
//
// The holder is a tiny module-scoped singleton that bootstrap (task
// 4.10) populates with the `SyncClient` returned by `startSupervisor`.
// Section 5 IPC handlers will import `getSyncClient()` and consume it
// at call time — this avoids threading a reference through every
// handler registration site.
//
// Invariants (updated per Decision 12, task 7.6):
//   1. `setSyncClient` may be called multiple times — first call is
//      bootstrap; subsequent calls replace the current client (reconnect
//      swap, F-5). The previous "once-only throws" behavior was relaxed
//      to support the supervisor reconnect lifecycle.
//   2. `getSyncClient` before set throws (guards against handler
//      invocation before bootstrap completes or after a failed
//      supervisor bring-up).
//   3. `__resetSyncClientForTesting` restores the null state so each
//      test is independent.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SyncClient } from "./client.js";
import {
  __resetSyncClientForTesting,
  getSyncClient,
  setSyncClient,
} from "./sync-client-holder.js";

// A minimal stand-in — the holder never touches the object, just
// stores and returns it. Casting to SyncClient is safe for this test
// surface.
const fakeClient = { __tag: "fake-sync-client" } as unknown as SyncClient;

beforeEach(() => {
  __resetSyncClientForTesting();
});

afterEach(() => {
  __resetSyncClientForTesting();
});

describe("sync-client-holder", () => {
  it("returns the client that was set", () => {
    setSyncClient(fakeClient);
    expect(getSyncClient()).toBe(fakeClient);
  });

  it("throws when getSyncClient is called before setSyncClient", () => {
    expect(() => getSyncClient()).toThrow(/not initialized/);
  });

  it("allows setSyncClient to be called multiple times (reconnect swap, Decision 12 F-5)", () => {
    setSyncClient(fakeClient);
    expect(getSyncClient()).toBe(fakeClient);
    const reconnectedClient = { __tag: "reconnected" } as unknown as SyncClient;
    // Second call replaces the current client — does NOT throw
    setSyncClient(reconnectedClient);
    expect(getSyncClient()).toBe(reconnectedClient);
    // Third call also works (further reconnects)
    const thirdClient = { __tag: "third" } as unknown as SyncClient;
    setSyncClient(thirdClient);
    expect(getSyncClient()).toBe(thirdClient);
  });

  it("__resetSyncClientForTesting clears the state so set/get work again", () => {
    setSyncClient(fakeClient);
    __resetSyncClientForTesting();
    expect(() => getSyncClient()).toThrow(/not initialized/);
    setSyncClient(fakeClient);
    expect(getSyncClient()).toBe(fakeClient);
  });
});
