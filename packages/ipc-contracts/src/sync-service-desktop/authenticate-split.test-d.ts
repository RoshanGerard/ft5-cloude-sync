// Renderer-facing types for the split authenticate flow (design.md Decision
// 10). The renderer calls `authenticateStart` to obtain a serializable intent
// plus a server-side correlation id, then `authenticateComplete` with the
// user's response bound to that correlation id.
//
// Style: matches the existing `SyncAuthenticateRequest/Response` shape —
// flat success types, errors thrown (not encoded as a `{ error }` union
// variant). This mirrors `authenticate` itself and keeps the new types
// symmetrical with what the renderer already consumes.
//
// Co-located with `requests.test-d.ts` rather than under `__tests__/`
// because the package tsconfig excludes `src/**/__tests__/**` from tsc and
// we want tsc -b to typecheck these assertions.

import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AuthResult,
  DatasourceType,
} from "../fs-datasource-engine.js";
import type {
  SerializableAuthCompletion,
  SerializableAuthIntent,
} from "../sync-service/commands.js";
import { SYNC_CHANNELS } from "./channels.js";
import type {
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateCompleteResponse,
  SyncAuthenticateStartRequest,
  SyncAuthenticateStartResponse,
} from "./requests.js";

describe("sync-service-desktop authenticate split — renderer contract", () => {
  it("authenticateStart request is { datasourceId, type }", () => {
    expectTypeOf<SyncAuthenticateStartRequest>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly type: DatasourceType;
    }>();
  });

  it("authenticateStart response is flat { correlationId, intent }", () => {
    expectTypeOf<SyncAuthenticateStartResponse>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly intent: SerializableAuthIntent;
    }>();
  });

  it("authenticateComplete request is { correlationId, completion }", () => {
    expectTypeOf<SyncAuthenticateCompleteRequest>().toEqualTypeOf<{
      readonly correlationId: string;
      readonly completion: SerializableAuthCompletion;
    }>();
  });

  it("authenticateComplete response is flat { authResult } — errors throw", () => {
    expectTypeOf<SyncAuthenticateCompleteResponse>().toEqualTypeOf<{
      readonly authResult: AuthResult;
    }>();
  });

  it("SYNC_CHANNELS.authenticateStart resolves to 'sync:authenticate-start'", () => {
    expect(SYNC_CHANNELS.authenticateStart).toBe("sync:authenticate-start");
    expectTypeOf<typeof SYNC_CHANNELS.authenticateStart>().toEqualTypeOf<
      "sync:authenticate-start"
    >();
  });

  it("SYNC_CHANNELS.authenticateComplete resolves to 'sync:authenticate-complete'", () => {
    expect(SYNC_CHANNELS.authenticateComplete).toBe(
      "sync:authenticate-complete",
    );
    expectTypeOf<typeof SYNC_CHANNELS.authenticateComplete>().toEqualTypeOf<
      "sync:authenticate-complete"
    >();
  });
});
