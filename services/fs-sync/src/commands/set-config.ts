// `sync:set-config` handler — implement-datasource-onboarding §12 +
// design.md Decision 4. Thin wrapper around
// `ServiceConfigStore.setRaw(...)` (atomic write + chmod 0o600 on Unix).
//
// Behaviour:
//   - Success → `{ok: true, result: {ok: true}}`.
//   - Any throw from setRaw (schemaVersion mismatch, EACCES, ENOSPC,
//     etc.) maps to `{tag: "io-error", message}`.
//
// Spec ref: same Requirement as `get-config`, scenario "set-config
// writes the file atomically and round-trips through get-config".

import type { CommandHandler } from "../ipc/server.js";
import type { ServiceConfigStore } from "../config/service-config-store.js";

export interface SetConfigHandlerDeps {
  readonly configStore: Pick<ServiceConfigStore, "setRaw">;
}

export function makeSetConfigHandler(
  deps: SetConfigHandlerDeps,
): CommandHandler<"sync:set-config"> {
  return async (params) => {
    try {
      await deps.configStore.setRaw(params.config);
      return { ok: true, result: { ok: true } };
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
