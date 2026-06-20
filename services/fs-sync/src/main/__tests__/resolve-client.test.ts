// Phase 5 of add-invalid-datasource-state — directly unit-tests the
// `resolveClient` adapter for the InvalidDatasource throw path. Per
// Decision 2 (single choke point), `resolveClient` is the service-side
// adapter that surfaces missing/corrupted credentials as the typed
// `DatasourceError({ tag: "invalid-datasource" })` so the renderer's
// `<InvalidDatasourceState>` and `<InvalidDatasourceBanner>` can render
// the actionable Reconnect / Remove affordances.

import { describe, expect, it, vi } from "vitest";

import {
  DatasourceError,
  DatasourceErrorTag,
} from "@ft5/ipc-contracts";
import type {
  ClientFactory,
  CredentialStore,
} from "@ft5/fs-datasource-engine";

import { createResolveClient } from "../resolve-client.js";

function makeCredentialStore(
  getImpl: () => Promise<unknown>,
): CredentialStore {
  return {
    get: vi.fn().mockImplementation(getImpl),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as CredentialStore;
}

function makeFactory(): ClientFactory {
  return {
    create: vi.fn(),
  } as unknown as ClientFactory;
}

describe("resolveClient — InvalidDatasource on missing credentials (§5)", () => {
  it("rejects with DatasourceError tag === invalid-datasource when credentialStore returns null", async () => {
    const credentialStore = makeCredentialStore(async () => null);
    const factory = makeFactory();
    const resolve = createResolveClient({ credentialStore, factory });

    await expect(resolve("ds-missing")).rejects.toBeInstanceOf(DatasourceError);
  });

  it("thrown error carries the real datasourceId, retryable: false, and a recognisable raw marker", async () => {
    const credentialStore = makeCredentialStore(async () => null);
    const factory = makeFactory();
    const resolve = createResolveClient({ credentialStore, factory });

    let caught: DatasourceError | undefined;
    try {
      await resolve("ds-eaa1");
    } catch (err) {
      caught = err as DatasourceError;
    }
    expect(caught).toBeInstanceOf(DatasourceError);
    expect(caught?.tag).toBe(DatasourceErrorTag.InvalidDatasource);
    expect(caught?.tag).toBe("invalid-datasource");
    expect(caught?.retryable).toBe(false);
    expect(caught?.datasourceId).toBe("ds-eaa1");
    expect(caught?.raw).toBe("no-credentials-registered");
    // The user-facing message should hint at the recovery action.
    expect(caught?.message).toMatch(/missing/i);
  });

  it("does NOT invoke factory.create when credentials are missing", async () => {
    const credentialStore = makeCredentialStore(async () => null);
    const factory = makeFactory();
    const resolve = createResolveClient({ credentialStore, factory });

    await expect(resolve("ds-1")).rejects.toBeInstanceOf(DatasourceError);
    expect(factory.create).not.toHaveBeenCalled();
  });
});
