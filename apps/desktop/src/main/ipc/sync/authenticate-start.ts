// wire-fs-sync-service task 5.A.14 — handleSyncAuthenticateStart [GREEN]
//
// Identity proxy over `SyncClient.authenticateStart`. First half of the
// two-step authenticate split (design.md Decision 10): the renderer asks
// the service to stage an authentication attempt; the service stores the
// live `AuthIntent` in its correlation map and returns a pure-data
// `SerializableAuthIntent` plus the correlation id the renderer will
// later pair with a `sync:authenticate-complete` call.
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
//     local token storage of any kind.
//
// The renderer `SyncAuthenticateStartRequest` and the wire
// `CommandParams<"sync:authenticate-start">` are structurally identical
// (`{ datasourceId, type }`), so forwarding is a one-liner with no
// shape translation. Registration in `ipc/index.ts` is handled by task
// 5.A.15.

import type {
  SyncAuthenticateStartRequest,
  SyncAuthenticateStartResponse,
} from "@ft5/ipc-contracts/sync-service-desktop";

import type { SyncClient } from "../../sync/client.js";
import { getSyncClient } from "../../sync/sync-client-holder.js";

export async function handleSyncAuthenticateStart(
  req: SyncAuthenticateStartRequest,
  client: SyncClient = getSyncClient(),
): Promise<SyncAuthenticateStartResponse> {
  return client.authenticateStart(req);
}
