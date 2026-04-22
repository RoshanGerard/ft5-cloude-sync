// wire-fs-sync-service task 5.12 — handleSyncAuthenticate [GREEN]
//
// Identity proxy over `SyncClient.authenticate`. Unlike the fallible
// handlers in this section (`enqueue-mirror`, `cancel-job`), the
// renderer response for `sync:authenticate` is a flat
// `{ authResult: AuthResult }` — no `{ result } | { error }` union.
// Every wire failure (`validation-error`, `authentication-failed`,
// service-disconnected, …) re-throws so the IPC layer surfaces it
// as an invoke rejection. The two documented fallible outcomes
// exposed as structured branches to the renderer are scoped to
// `enqueueMirror` and `cancelJob` (see
// `sync-service-desktop/requests.ts` header).
//
// Security invariant — credential ownership lives on the service
// (see wire-fs-sync-service design.md "Decision 1 — Credential
// ownership"). This handler:
//   - carries the request params straight through to the service,
//   - returns the service's reply straight through,
//   - does NOT persist, encrypt, stash, mutate, or log any token,
//     credential, or intent payload.
//
// The renderer `SyncAuthenticateRequest` and the wire
// `CommandParams<"sync:authenticate">` are structurally identical
// (`{ datasourceId, type, intent }`, where `intent` is the same
// `AuthIntent` union imported from `@ft5/ipc-contracts`), so the
// forwarding is a one-liner with no shape translation. Registration
// in `ipc/index.ts` is deferred to task 5.14.

import type {
  SyncAuthenticateRequest,
  SyncAuthenticateResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncAuthenticate(
  req: SyncAuthenticateRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncAuthenticateResponse> {
  return client.authenticate({
    datasourceId: req.datasourceId,
    type: req.type,
    intent: req.intent,
  });
}
