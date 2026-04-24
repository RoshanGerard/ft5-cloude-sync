// Stub handler for the `sync:authenticate-complete` wire command.
//
// This handler is intentionally a no-op returning `{ ok: false, error:
// { tag: "not-implemented", ... } }`. The real service-side authenticate
// flow is deferred to the follow-up OpenSpec change
// `implement-datasource-onboarding` per design.md Decision 11.
//
// Because the stub does no work, it does NOT consult the correlation
// store or the engine — it ignores all params and responds uniformly.

import type { CommandHandler } from "../ipc/server.js";

export const handleAuthenticateComplete: CommandHandler<"sync:authenticate-complete"> =
  async () => ({
    ok: false,
    error: {
      tag: "not-implemented",
      message:
        "authenticate flow pending follow-up change — see openspec design.md Decision 11",
    },
  });
