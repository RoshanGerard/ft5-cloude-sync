// Tests for the `sync:delete-credentials` handler — implement-
// datasource-onboarding §13. Symmetric counterpart to authenticate per
// design.md Decision 12. Best-effort cleanup: failures log a warning but
// the response is still `{ok: true, result: {deleted: false}}` rather
// than an error.

import { describe, expect, it, vi } from "vitest";

import type { CredentialStore } from "@ft5/fs-datasource-engine";
import type { StoredCredentials } from "@ft5/ipc-contracts";
import type { Connection } from "../ipc/server.js";

import { makeDeleteCredentialsHandler } from "./delete-credentials.js";

const ctx = (): { readonly connection: Connection } => ({
  connection: {
    id: 1,
    closed: false,
    sendEvent: () => void 0,
  },
});

interface FakeStore extends CredentialStore {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeFakeStore(opts: {
  storedCreds?: Record<string, StoredCredentials>;
  deleteThrows?: Error;
} = {}): FakeStore {
  const stored = { ...(opts.storedCreds ?? {}) };
  return {
    get: vi.fn(async (id: string) => stored[id] ?? null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async (id: string) => {
      if (opts.deleteThrows) throw opts.deleteThrows;
      delete stored[id];
    }),
  } as unknown as FakeStore;
}

describe("sync:delete-credentials handler — implement-datasource-onboarding §13", () => {
  it("returns deleted=true when the credential exists; subsequent get is null", async () => {
    const stored: StoredCredentials = {
      providerId: "amazon-s3",
      authResult: { accessToken: "" },
      createdAt: 0,
      updatedAt: 0,
    };
    const store = makeFakeStore({ storedCreds: { "ds-X": stored } });
    const handler = makeDeleteCredentialsHandler({ credentialStore: store });

    const res = await handler({ datasourceId: "ds-X" }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.deleted).toBe(true);

    expect(store.delete).toHaveBeenCalledTimes(1);
    expect(store.delete).toHaveBeenCalledWith("ds-X");

    // Subsequent get is null — the fake store actually removes the entry.
    expect(await store.get("ds-X")).toBeNull();
  });

  it("returns deleted=false when no entry exists; credential store unchanged", async () => {
    const store = makeFakeStore({ storedCreds: {} });
    const handler = makeDeleteCredentialsHandler({ credentialStore: store });

    const res = await handler({ datasourceId: "ds-Y" }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.deleted).toBe(false);

    // delete was NOT called (handler avoided the no-op write).
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("on delete-throws logs structured warning and returns deleted=false (best-effort)", async () => {
    const stored: StoredCredentials = {
      providerId: "amazon-s3",
      authResult: { accessToken: "" },
      createdAt: 0,
      updatedAt: 0,
    };
    const store = makeFakeStore({
      storedCreds: { "ds-Z": stored },
      deleteThrows: new Error("EACCES: cannot write"),
    });
    const log = {
      warn: vi.fn(),
    };
    const handler = makeDeleteCredentialsHandler({
      credentialStore: store,
      logger: log,
    });

    const res = await handler({ datasourceId: "ds-Z" }, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.deleted).toBe(false);

    // Structured warning fired.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toBe("bridge-credential-delete-failed");
    const fields = log.warn.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields).toMatchObject({
      datasourceId: "ds-Z",
      errorMessage: "EACCES: cannot write",
    });
  });
});
