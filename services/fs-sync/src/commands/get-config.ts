// `sync:get-config` handler — implement-datasource-onboarding §12 +
// design.md Decision 4. Thin wrapper around `ServiceConfigStore.getRaw()`.
//
// Behaviour:
//   - File absent → returns `{schemaVersion: 1, providers: {}}` (the
//     getRaw default per §6).
//   - File exists but unparseable / unexpected shape / other I/O error
//     → maps to `{ok: false, error: {tag: "io-error", message}}`.
//
// Spec ref: openspec/changes/implement-datasource-onboarding/specs/
//   fs-sync-service/spec.md ADDED Requirement
//   "sync:get-config and sync:set-config expose the service config to
//   the desktop", scenario "get-config returns the empty shape when
//   file is absent".

import type { CommandHandler } from "../ipc/server.js";
import type { ServiceConfigStore } from "../config/service-config-store.js";

export interface GetConfigHandlerDeps {
  readonly configStore: Pick<ServiceConfigStore, "getRaw">;
}

export function makeGetConfigHandler(
  deps: GetConfigHandlerDeps,
): CommandHandler<"sync:get-config"> {
  return async () => {
    try {
      const config = await deps.configStore.getRaw();
      return { ok: true, result: { config } };
    } catch (err) {
      return {
        ok: false,
        error: {
          tag: "io-error",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  };
}
