// Stub handler for the `sync:authenticate-start` wire command.
//
// This handler is intentionally a no-op returning `{ ok: false, error:
// { tag: "not-implemented", ... } }`. The real service-side authenticate
// flow is deferred to the follow-up OpenSpec change
// `implement-datasource-onboarding` per design.md Decision 11.
//
// The wire contract, desktop-side wrappers, IPC handlers, and preload
// surface all ship in their final two-command shape in this branch; the
// `not-implemented` tag propagates through that finished surface until
// the follow-up replaces this stub with a real implementation.

import type { CommandHandler } from "../ipc/server.js";

export const handleAuthenticateStart: CommandHandler<"sync:authenticate-start"> =
  async () => ({
    ok: false,
    error: {
      tag: "not-implemented",
      message:
        "authenticate flow pending follow-up change — see openspec design.md Decision 11",
    },
  });
