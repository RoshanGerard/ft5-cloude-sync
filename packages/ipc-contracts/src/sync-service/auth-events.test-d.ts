// Wire contract for the `auth-*` event taxonomy added by the
// `implement-datasource-onboarding` change (design.md Decision 7).
//
// The service event stream gains seven new variants:
//
// * `auth-initiated` — the only renderer-visible "we just kicked off"
//   notification; carries the correlationId, providerId, and the
//   datasourceId for reconnect flows.
// * `auth-completed` — the user-facing terminal event the renderer
//   consumes for UI updates (dialog close, dashboard refresh).
// * `auth-cancelled` — fired exactly once per active correlation when
//   `sync:authenticate-cancel` consumes a live correlation (or the
//   loopback timer + cancel race resolves to cancel).
// * `auth-failed` — fired on the loopback `state` mismatch, on a
//   `completeWith` rejection, or on engine errors during `submit`.
// * `auth-timeout` — fired on the 5-minute loopback timer.
// * `oauth-open-url` — bridge-only event consumed by desktop main's
//   sync event-bridge to call `shell.openExternal(authorizeUrl)`. The
//   renderer SHALL NEVER receive this event.
// * `credential-persisted` — bridge-only event consumed by desktop
//   main's sync event-bridge to call `getEngine().registry.add(summary)`.
//   The renderer SHALL NEVER receive this event.
//
// `auth-completed` and `credential-persisted` carry overlapping data; their
// distinct identities exist so the bridge can filter the bridge-only
// variants out of the renderer-bound forward.

import { describe, expectTypeOf, it } from "vitest";

import type {
  DatasourceSummary,
  ProviderId,
} from "../datasources.js";
import type {
  AuthCancelledPayload,
  AuthCompletedPayload,
  AuthFailedPayload,
  AuthFailedTag,
  AuthInitiatedPayload,
  AuthTimeoutPayload,
  CredentialPersistedPayload,
  EVENT_NAMES,
  EventName,
  EventPayloadMap,
  OAuthOpenUrlPayload,
  ServiceEvent,
} from "./events.js";

describe("sync-service auth-* event taxonomy — implement-datasource-onboarding", () => {
  it("EventName union contains every auth-* + bridge-only variant", () => {
    type AuthFamily =
      | "auth-initiated"
      | "auth-completed"
      | "auth-cancelled"
      | "auth-failed"
      | "auth-timeout"
      | "oauth-open-url"
      | "credential-persisted";
    expectTypeOf<AuthFamily>().toMatchTypeOf<EventName>();
  });

  it("auth-initiated payload is { correlationId, providerId, datasourceId? }", () => {
    expectTypeOf<AuthInitiatedPayload>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly providerId: ProviderId;
      readonly datasourceId?: string;
    }>();
    expectTypeOf<EventPayloadMap["auth-initiated"]>().toEqualTypeOf<
      AuthInitiatedPayload
    >();
  });

  it("auth-completed payload is { correlationId, datasourceId, summary }", () => {
    expectTypeOf<AuthCompletedPayload>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly datasourceId: string;
      readonly summary: DatasourceSummary;
    }>();
    expectTypeOf<EventPayloadMap["auth-completed"]>().toEqualTypeOf<
      AuthCompletedPayload
    >();
  });

  it("auth-cancelled payload is { correlationId }", () => {
    expectTypeOf<AuthCancelledPayload>().toEqualTypeOf<{
      readonly correlationId: string;
    }>();
    expectTypeOf<EventPayloadMap["auth-cancelled"]>().toEqualTypeOf<
      AuthCancelledPayload
    >();
  });

  it("auth-failed payload is { correlationId, tag, message? }", () => {
    expectTypeOf<AuthFailedPayload>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly tag: AuthFailedTag;
      readonly message?: string;
    }>();
    expectTypeOf<EventPayloadMap["auth-failed"]>().toEqualTypeOf<
      AuthFailedPayload
    >();
  });

  it("AuthFailedTag union contains at least auth-revoked + provider-error", () => {
    expectTypeOf<"auth-revoked">().toMatchTypeOf<AuthFailedTag>();
    expectTypeOf<"provider-error">().toMatchTypeOf<AuthFailedTag>();
  });

  it("auth-timeout payload is { correlationId }", () => {
    expectTypeOf<AuthTimeoutPayload>().toEqualTypeOf<{
      readonly correlationId: string;
    }>();
    expectTypeOf<EventPayloadMap["auth-timeout"]>().toEqualTypeOf<
      AuthTimeoutPayload
    >();
  });

  it("oauth-open-url payload is { correlationId, authorizeUrl }", () => {
    expectTypeOf<OAuthOpenUrlPayload>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly authorizeUrl: string;
    }>();
    expectTypeOf<EventPayloadMap["oauth-open-url"]>().toEqualTypeOf<
      OAuthOpenUrlPayload
    >();
  });

  it("credential-persisted payload is { correlationId, datasourceId, summary }", () => {
    expectTypeOf<CredentialPersistedPayload>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly datasourceId: string;
      readonly summary: DatasourceSummary;
    }>();
    expectTypeOf<EventPayloadMap["credential-persisted"]>().toEqualTypeOf<
      CredentialPersistedPayload
    >();
  });

  it("ServiceEvent narrows correctly under switch on `name` for new variants", () => {
    type AuthInitiatedEvent = Extract<ServiceEvent, { name: "auth-initiated" }>;
    expectTypeOf<AuthInitiatedEvent>().toEqualTypeOf<{
      readonly name: "auth-initiated";
      readonly payload: AuthInitiatedPayload;
    }>();

    type OAuthOpenUrlEvent = Extract<ServiceEvent, { name: "oauth-open-url" }>;
    expectTypeOf<OAuthOpenUrlEvent>().toEqualTypeOf<{
      readonly name: "oauth-open-url";
      readonly payload: OAuthOpenUrlPayload;
    }>();
  });

  it("EVENT_NAMES tuple contains every new auth-* + bridge-only entry", () => {
    expectTypeOf<(typeof EVENT_NAMES)[number]>().toEqualTypeOf<EventName>();
  });
});
