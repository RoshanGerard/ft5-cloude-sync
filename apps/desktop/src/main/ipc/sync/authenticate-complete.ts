// implement-datasource-onboarding §Prerequisite A — handleSyncAuthenticateComplete
//
// Wraps the underlying `SyncClient.authenticateComplete()` round-trip so the
// renderer-facing `SyncAuthenticateCompleteResponse` envelope (`{ ok: true,
// result } | { ok: false, error }`) is constructed at the desktop boundary.
// The wire `CommandResult<"sync:authenticate-complete">` returned by the
// service is the bare `{ datasourceId, summary }` shape; `SyncCommandError`
// thrown by the client carries the wire's typed error union under `.raw`.
//
// Security invariant — credential ownership lives on the service
// (`wire-fs-sync-service` design Decision 1, restated in this change's
// design Decision 1). This handler:
//   - carries the request params straight through to the service,
//   - wraps the reply in the renderer's discriminated envelope without
//     mutating its content,
//   - does NOT persist, encrypt, cache, or inspect any credential
//     material. No filesystem writes, no OS keychain access, no
//     local token storage of any kind. That applies equally to the
//     incoming completion (credentials-form values) and to the
//     outgoing AuthResult.

import type {
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateCompleteResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";
import type { SyncAuthenticateCompleteError } from "@ft5/ipc-contracts/sync-service";

import { SyncClient, SyncCommandError } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncAuthenticateComplete(
  req: SyncAuthenticateCompleteRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncAuthenticateCompleteResponse> {
  try {
    const result = await client.authenticateComplete(req);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof SyncCommandError) {
      return {
        ok: false,
        error: err.raw as SyncAuthenticateCompleteError,
      };
    }
    throw err;
  }
}
