// Contract-removal tests for `implement-datasource-onboarding` §5.3 + §5.4.
//
// Per the modified `datasources-ui` capability requirement "Datasource IPC
// surface is the single data path", the `consent-*` event taxonomy and the
// `startConsent` / `cancelConsent` request/response surface SHALL NOT be
// present on `@ft5/ipc-contracts/datasources` after this change.
// Authentication lifecycle now flows through the service via the
// `auth-*` taxonomy on `sync:event` (see `sync-service` capability).
//
// Strategy: the type-level absence of removed types is enforced by tsc —
// if any in-package consumer imports `ConsentEvent` /
// `DatasourcesStartConsentRequest` etc. after the deletion, the build
// fails. The runtime tests below cover the runtime-visible removals:
// the `startConsent` / `cancelConsent` keys on `DATASOURCES_CHANNELS`.

import { describe, expect, expectTypeOf, it } from "vitest";

import { DATASOURCES_CHANNELS } from "../datasources.js";

describe("ipc-contracts datasources — consent surface is fully retired", () => {
  it("DATASOURCES_CHANNELS does NOT carry startConsent / cancelConsent keys at the type level", () => {
    type Channels = typeof DATASOURCES_CHANNELS;
    type HasStartConsent = "startConsent" extends keyof Channels ? true : false;
    type HasCancelConsent = "cancelConsent" extends keyof Channels ? true : false;
    expectTypeOf<HasStartConsent>().toEqualTypeOf<false>();
    expectTypeOf<HasCancelConsent>().toEqualTypeOf<false>();
  });

  it("DATASOURCES_CHANNELS does NOT carry startConsent / cancelConsent keys at runtime", () => {
    expect(
      Object.prototype.hasOwnProperty.call(DATASOURCES_CHANNELS, "startConsent"),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        DATASOURCES_CHANNELS,
        "cancelConsent",
      ),
    ).toBe(false);
  });

  it("DATASOURCES_CHANNELS still exposes the non-consent keys", () => {
    // Sanity check: removing consent-* should leave the rest intact.
    // `uploadProgress` was additionally removed by
    // migrate-upload-orchestration-out-of-engine §7.5 / §13.4 — the
    // upload-event channel migrated to `sync:event-stream` keyed by
    // `uploadJobId`. `event` (`datasources:event`) was removed by
    // migrate-engine-events-to-consumer Decision 4 along with the engine
    // EventBus — it had no production emitter or consumer; datasource-
    // facing events flow as `auth-*` / `job-*` on `sync:event`.
    const remaining = Object.keys(DATASOURCES_CHANNELS).sort();
    expect(remaining).toEqual(
      [
        "action",
        "add",
        "list",
        "pickFilesToUpload",
        "remove",
      ].sort(),
    );
  });
});
