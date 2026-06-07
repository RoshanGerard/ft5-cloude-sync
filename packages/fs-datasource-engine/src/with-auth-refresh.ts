// withAuthRefresh — the engine's default, replaceable one-shot
// refresh-then-retry policy (migrate-engine-retry-policy-to-consumer
// Decision 3). It is the behaviour the base class used to bake in via the
// now-removed `withRefresh`: run the operation; on a normalized
// `auth-expired`, refresh credentials once and retry the operation exactly
// once. A second `auth-expired` propagates — the helper does NOT refresh
// twice. Any non-`auth-expired` rejection propagates immediately, without a
// refresh.
//
// The helper is framework-agnostic: it refers to its argument only as a
// CALLER that can refresh (`Pick<DatasourceClient<…>, "refreshCredentials">`)
// and detects the retryable case via the exported `DatasourceError` class +
// `auth-expired` tag — errors are already normalized by the base before they
// cross the package boundary, so no `normalizeError` export is needed. It
// makes ZERO reference to any specific consumer (e.g. fs-sync). Callers MAY
// use it or implement their own retry policy directly against the public
// `refreshCredentials()` primitive.

import { DatasourceError } from "@ft5/ipc-contracts";
import type { DatasourceType } from "@ft5/ipc-contracts";

import type { DatasourceClient } from "./base-client.js";

/**
 * Run `op()`; if it rejects with a `DatasourceError` whose
 * `tag === "auth-expired"`, call `client.refreshCredentials()` and retry
 * `op()` exactly once. Any other rejection (a non-`DatasourceError`, or a
 * `DatasourceError` with a different tag) propagates WITHOUT a refresh. A
 * second `auth-expired` thrown by the retry propagates unchanged — the
 * helper does NOT refresh twice.
 */
export async function withAuthRefresh<R>(
  client: Pick<DatasourceClient<DatasourceType>, "refreshCredentials">,
  op: () => Promise<R>,
): Promise<R> {
  try {
    return await op();
  } catch (err) {
    if (!(err instanceof DatasourceError) || err.tag !== "auth-expired") {
      throw err;
    }
    await client.refreshCredentials();
    // Retry once — a second auth-expired (or any other error) propagates.
    return await op();
  }
}
