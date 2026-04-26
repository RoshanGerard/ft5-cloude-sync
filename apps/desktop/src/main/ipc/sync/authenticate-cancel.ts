// implement-datasource-onboarding §Prerequisite A — handleSyncAuthenticateCancel
//
// Wraps the underlying `SyncClient.authenticateCancel()` round-trip so the
// renderer-facing `SyncAuthenticateCancelResponse` envelope (`{ ok: true,
// result } | { ok: false, error }`) is constructed at the desktop boundary.
// The wire `CommandResult<"sync:authenticate-cancel">` returned by the
// service is the bare `{ cancelled: boolean }` shape; `SyncCommandError`
// thrown by the client carries the wire's typed error union under `.raw`.
//
// Cancel is idempotent at the service: a second call against the same
// correlationId returns `{ cancelled: false }` rather than erroring. The
// `correlation-not-found` tag fires only on malformed input (validation).

import type {
  SyncAuthenticateCancelRequest,
  SyncAuthenticateCancelResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";
import type { SyncAuthenticateCancelError } from "@ft5/ipc-contracts/sync-service";

import { SyncClient, SyncCommandError } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncAuthenticateCancel(
  req: SyncAuthenticateCancelRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncAuthenticateCancelResponse> {
  try {
    const result = await client.authenticateCancel(req);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof SyncCommandError) {
      return {
        ok: false,
        error: err.raw as SyncAuthenticateCancelError,
      };
    }
    throw err;
  }
}
