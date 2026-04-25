// Phase 3 of add-invalid-datasource-state — focused tests for the
// InvalidDatasource code paths in `ClientFactory.create`.
//
// The pre-existing fixture in `factory.test.ts` covers the unknown-
// providerId case at the structural level (instanceof + tag + raw +
// retryable). This file adds the spec-mandated detail assertions:
//
//   - Unknown provider id: the `message` names the unknown provider id
//     (per spec MODIFIED scenario "Unknown provider id throws
//     InvalidDatasource").
//   - Wrong-shape credential: the `message` identifies the failing field
//     (per spec MODIFIED scenario "Wrong-shape credential throws
//     InvalidDatasource"). This test is added in §3.5 after the
//     `validateCredentialShape` helper lands.

import { describe, expect, it, vi } from "vitest";

import {
  DatasourceError,
  DatasourceErrorTag,
  type ProviderId,
  type StoredCredentials,
} from "@ft5/ipc-contracts";

import { createEventBus } from "../event-bus.js";
import type { CredentialStore } from "../credential-store.js";
import {
  createClientFactory,
  type CredentialShapeValidator,
  type EngineContext,
  type ProviderFactoryFn,
  type ProviderRegistry,
  type ProviderRegistryEntry,
} from "../factory.js";
import {
  validateGoogleDriveCredentialShape,
} from "../strategies/googledrive-client.js";

function makeCredentialStore(): CredentialStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEngineContext(): EngineContext {
  return {
    bus: createEventBus(),
    credentialStore: makeCredentialStore(),
  };
}

/** Spy registry entry where `create` and `validateCredentialShape` are
 * both no-op `vi.fn`s. Tests that exercise the shape-validation path
 * override the entry's `validateCredentialShape` with the real
 * per-provider validator. */
function makeSpyRegistryEntry<P extends ProviderId>(): ProviderRegistryEntry<P> {
  return {
    create: vi.fn<ProviderFactoryFn<P>>(),
    validateCredentialShape: vi.fn<CredentialShapeValidator>(),
  };
}

const driveCreds: StoredCredentials = {
  providerId: "google-drive",
  authResult: {
    accessToken: "drive-token",
    refreshToken: "drive-refresh",
    meta: {
      clientId: "dummy-client-id",
      clientSecret: "dummy-client-secret",
      redirectUri: "http://localhost/callback",
    },
  },
  createdAt: 0,
  updatedAt: 0,
};

// Wrong-shape credential payloads. The cast forces them past the
// `StoredCredentials` static guard so we can exercise the runtime shape
// check at `factory.create`.
const s3CredsForDriveSlot: StoredCredentials = {
  providerId: "google-drive",
  authResult: {
    accessToken: "",
    meta: {
      accessKeyId: "AKIA-DUMMY",
      secretAccessKey: "SK-DUMMY",
      region: "us-east-1",
      bucket: "dummy-bucket",
    },
  },
  createdAt: 0,
  updatedAt: 0,
} as unknown as StoredCredentials;

const driveCredsMissingAccessToken: StoredCredentials = {
  providerId: "google-drive",
  authResult: {
    // accessToken intentionally missing (cast bypasses static guard)
    refreshToken: "drive-refresh",
    meta: {
      clientId: "dummy-client-id",
      clientSecret: "dummy-client-secret",
      redirectUri: "http://localhost/callback",
    },
  },
  createdAt: 0,
  updatedAt: 0,
} as unknown as StoredCredentials;

describe("ClientFactory.create — InvalidDatasource (Decision 2)", () => {
  it("uses DatasourceErrorTag.InvalidDatasource for unknown providerId", () => {
    const ctx = makeEngineContext();
    const registry: ProviderRegistry = {
      "amazon-s3": makeSpyRegistryEntry<"amazon-s3">(),
      "google-drive": makeSpyRegistryEntry<"google-drive">(),
      onedrive: makeSpyRegistryEntry<"onedrive">(),
    };
    const factory = createClientFactory(registry);

    try {
      factory.create(
        "dropbox" as unknown as ProviderId,
        "ds-1",
        driveCreds,
        ctx,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DatasourceError);
      const e = err as DatasourceError;
      expect(e.tag).toBe(DatasourceErrorTag.InvalidDatasource);
      expect(e.tag).toBe("invalid-datasource");
      expect(e.retryable).toBe(false);
    }
  });

  it("error message names the unknown provider id (spec scenario)", () => {
    const ctx = makeEngineContext();
    const registry: ProviderRegistry = {
      "amazon-s3": makeSpyRegistryEntry<"amazon-s3">(),
      "google-drive": makeSpyRegistryEntry<"google-drive">(),
      onedrive: makeSpyRegistryEntry<"onedrive">(),
    };
    const factory = createClientFactory(registry);

    try {
      factory.create(
        "dropbox" as unknown as ProviderId,
        "ds-2",
        driveCreds,
        ctx,
      );
      throw new Error("expected throw");
    } catch (err) {
      const e = err as DatasourceError;
      // Spec: "a message that names the unknown provider id". The
      // pre-refactor message format kept the unknown id in the
      // `'<id>'` literal — preserve that so log-scrapers don't break.
      expect(e.message).toContain("dropbox");
    }
  });
});

/** Registry entry that uses the REAL google-drive validator (so the
 * shape-rejection path runs end-to-end against production code), but
 * stubs `create` so the test doesn't need a real GoogleDriveClient. */
function makeRealValidatorDriveEntry(): ProviderRegistryEntry<"google-drive"> {
  return {
    create: vi.fn<ProviderFactoryFn<"google-drive">>(),
    validateCredentialShape: validateGoogleDriveCredentialShape,
  };
}

describe("ClientFactory.create — wrong-shape credential rejection (§3.5–3.7)", () => {
  it("S3-shape credential supplied for google-drive providerId throws InvalidDatasource", () => {
    const ctx = makeEngineContext();
    const driveEntry = makeRealValidatorDriveEntry();
    const registry: ProviderRegistry = {
      "amazon-s3": makeSpyRegistryEntry<"amazon-s3">(),
      "google-drive": driveEntry,
      onedrive: makeSpyRegistryEntry<"onedrive">(),
    };
    const factory = createClientFactory(registry);

    try {
      factory.create("google-drive", "ds-3", s3CredsForDriveSlot, ctx);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DatasourceError);
      const e = err as DatasourceError;
      expect(e.tag).toBe(DatasourceErrorTag.InvalidDatasource);
      expect(e.retryable).toBe(false);
    }

    // The strategy factory MUST NOT have been invoked when shape
    // validation rejects the credential.
    expect(driveEntry.create).not.toHaveBeenCalled();
  });

  it("error message identifies the missing field (spec scenario)", () => {
    const ctx = makeEngineContext();
    const registry: ProviderRegistry = {
      "amazon-s3": makeSpyRegistryEntry<"amazon-s3">(),
      "google-drive": makeRealValidatorDriveEntry(),
      onedrive: makeSpyRegistryEntry<"onedrive">(),
    };
    const factory = createClientFactory(registry);

    try {
      factory.create(
        "google-drive",
        "ds-4",
        driveCredsMissingAccessToken,
        ctx,
      );
      throw new Error("expected throw");
    } catch (err) {
      const e = err as DatasourceError;
      // Spec: "a message that identifies the failing field
      // (e.g., 'google-drive credential is missing accessToken')"
      expect(e.message).toMatch(/google-drive/);
      expect(e.message).toMatch(/accessToken/);
    }
  });
});
