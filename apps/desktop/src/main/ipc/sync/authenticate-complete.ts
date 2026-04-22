// wire-fs-sync-service task 5.A.14 — handleSyncAuthenticateComplete [GREEN]
//
// Identity proxy over `SyncClient.authenticateComplete`. Second half of
// the two-step authenticate split (design.md Decision 10): the renderer
// posts the user's response (OAuth `code` or credentials-form `values`)
// against the correlation id returned by the matching
// `sync:authenticate-start` call. The service looks up the stashed
// live `AuthIntent` and dispatches against its kind.
//
// The service-side handler currently ships as a stub returning
// `{ ok: false, error: { tag: "not-implemented", ... } }` — see
// design.md Decision 11 and the follow-up change
// `implement-datasource-onboarding`. That stubbed outcome re-throws
// verbatim through this handler as `SyncCommandError { tag:
// "not-implemented" }`, which the IPC layer surfaces as a rejected
// invoke.
//
// Security invariant — credential ownership lives on the service
// (design.md "Decision 1 — Credential ownership"). This handler:
//   - carries the request params straight through to the service,
//   - returns the service's reply straight through,
//   - does NOT persist, encrypt, cache, or inspect any credential
//     material. No filesystem writes, no OS keychain access, no
//     local token storage of any kind. That applies equally to the
//     incoming completion (OAuth code / credentials-form values) and
//     to the outgoing AuthResult.
//
// The renderer `SyncAuthenticateCompleteRequest` and the wire
// `CommandParams<"sync:authenticate-complete">` are structurally
// identical (`{ correlationId, completion }`), so forwarding is a
// one-liner with no shape translation. Registration in `ipc/index.ts`
// is handled by task 5.A.15.

import type {
  SyncAuthenticateCompleteRequest,
  SyncAuthenticateCompleteResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncAuthenticateComplete(
  req: SyncAuthenticateCompleteRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncAuthenticateCompleteResponse> {
  return client.authenticateComplete(req);
}
