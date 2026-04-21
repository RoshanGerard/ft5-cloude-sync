// V1 does NOT expose auto-sync commands. The enum in `@ft5/ipc-contracts/
// sync-service` must not include sync:enable-auto / sync:disable-auto;
// any request for those commands should be rejected with tag='unknown-
// command' by the dispatcher.

import { COMMAND_NAMES } from "@ft5/ipc-contracts/sync-service";
import { describe, expect, it } from "vitest";

describe("sync-service command enum — v1 surface", () => {
  it("COMMAND_NAMES does not include sync:enable-auto / sync:disable-auto", () => {
    const names = COMMAND_NAMES as ReadonlyArray<string>;
    expect(names).not.toContain("sync:enable-auto");
    expect(names).not.toContain("sync:disable-auto");
  });
});
