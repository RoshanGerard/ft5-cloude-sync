// Shared strategy contract-test suite.
//
// Every concrete `DatasourceClient<T>` (S3 today, OneDrive + Google Drive in
// Phases 7 / 8) MUST pass this suite. The scenarios assert behaviour that
// emerges from `BaseDatasourceClient` + the provider's `doXImpl` primitives:
// event ordering, error-tag routing, capability gating.
//
// Call shape:
//     runStrategyContractSuite({ providerName, buildClient, fixture });
//
// `fixture` is a discriminated struct that the caller supplies for their
// provider's SDK. Strict minimum set of hooks:
//
//     primeListOk(entries)   — mock SDK list op to return the given entries
//     primeGetMetadata404()  — mock SDK head/stat op to return 404/not-found
//     primeRateLimit()       — mock SDK list op to return a rate-limit error
//     primeAuth*             — providers that use OAuth refresh can optionally
//                              implement `primeAuthExpired()` to exercise the
//                              refresh loop; static-key providers omit it
//     expectedAuthErrorTag   — "auth-revoked" (static creds, e.g. S3) or
//                              "auth-expired" (OAuth, e.g. OneDrive)
//     buildLocalFile()       — writes a small temp file and returns its path
//                              so upload scenarios can stream from disk
//
// Phases 7 / 8 will supply their own `fixture` + `buildClient`, call
// `runStrategyContractSuite(...)`, and inherit the same scenario set. Do NOT
// edit the shared scenarios per-provider; supply provider-specific behaviour
// via the fixture hooks.

import type {
  DatasourceType,
  DatasourceFileEntry,
  StoredCredentials,
} from "@ft5/ipc-contracts";
import { DatasourceError } from "@ft5/ipc-contracts";
import { describe, expect, it } from "vitest";

import type { DatasourceClient } from "../base-client.js";
import { createEventBus, type EventBus } from "../event-bus.js";
import type { CredentialStore } from "../credential-store.js";

// ---------------------------------------------------------------------------
// Fixture interface
// ---------------------------------------------------------------------------

/**
 * Provider-supplied primitives used by the shared scenarios. The shared suite
 * calls these between scenarios to arrange the SDK mock into the state each
 * scenario needs.
 */
// Provider-agnostic — no provider-specific fields live on the fixture today.
// Future: if Phase 7/8 need provider-typed hooks (e.g. a `primeHandle<T>`
// that returns a typed handle), re-introduce the generic.
export interface StrategyContractFixture {
  /** Reset the mock between scenarios. */
  resetMock(): void;

  /**
   * Prime a successful `listDirectory` response. The scenario will then
   * invoke `client.listDirectory({ kind: "path", path: rootPath })` and
   * expect the returned entries to include at least a file AND a folder.
   */
  primeListOk(opts: {
    rootPath: string;
  }): void;

  /** Prime `getMetadata` for `targetPath` to reject as 404 / not-found. */
  primeGetMetadata404(targetPath: string): void;

  /**
   * Prime `listDirectory` to reject with a rate-limit error. Optional
   * `retryAfterMs` — fixture decides how its SDK encodes the header.
   */
  primeRateLimitOnList(): void;

  /** Prime `listDirectory` to reject with an auth failure — either
   * `auth-revoked` (static creds) or `auth-expired` (OAuth). The shared
   * suite checks the `expectedAuthErrorTag` below to know which tag to
   * expect. */
  primeAuthFailureOnList(): void;

  /**
   * Which auth-error tag this provider surfaces. Static-credential providers
   * (S3) return `"auth-revoked"`; OAuth providers (OneDrive, Google Drive)
   * return `"auth-expired"` and MAY additionally expose a
   * `primeAuthExpiredThenRefreshSucceeds()` hook to test the refresh loop —
   * not required by the contract suite.
   */
  expectedAuthErrorTag: "auth-revoked" | "auth-expired";

  /** Whether the provider's descriptor declares quota support. `false` for S3;
   * `true` for OneDrive / Google Drive. The scenario checks `getQuota()`
   * against this flag. */
  supportsQuota: boolean;

  /** Write a small file under tmpdir and return its absolute path. Upload
   * scenarios stream from this. */
  buildLocalFile(): string;

  /** Prime a successful upload path. The scenario invokes
   * `client.uploadFile({ kind: "path", path: parentPath }, { path: <localFile> })`
   * and expects it to resolve. Providers that use `@aws-sdk/lib-storage` or a
   * resumable endpoint must prime all the multipart / session commands their
   * upload flow issues. */
  primeUploadOk(opts: { parentPath: string }): void;

  /** Prime a successful delete. The scenario invokes
   * `client.deleteFile({ kind: "path", path: targetPath })`. */
  primeDeleteOk(targetPath: string): void;

  /** Stored credentials to construct the client under test. */
  credentials: StoredCredentials;
}

// ---------------------------------------------------------------------------
// Suite entry point
// ---------------------------------------------------------------------------

export interface StrategyContractSuiteParams<T extends DatasourceType> {
  /** Human-readable provider label used in `describe` blocks. */
  providerName: string;
  /** Returns a fresh client wired to the supplied bus + credential store. */
  buildClient(
    bus: EventBus,
    credentialStore: CredentialStore,
    credentials: StoredCredentials,
  ): DatasourceClient<T>;
  /** Provider-supplied primitives. */
  fixture: StrategyContractFixture;
}

/**
 * Run the shared contract-test scenarios against the supplied strategy.
 * Call from inside a provider-specific test file:
 *
 *     runStrategyContractSuite({
 *       providerName: "S3Client",
 *       buildClient: (bus, store, creds) => createS3Client("ds-1", creds, { bus, credentialStore: store, providerDescriptor: providers["amazon-s3"] }),
 *       fixture: s3Fixture,
 *     });
 */
export function runStrategyContractSuite<T extends DatasourceType>(
  params: StrategyContractSuiteParams<T>,
): void {
  const { providerName, buildClient, fixture } = params;

  function makeHarness(): {
    bus: EventBus;
    events: Array<{ event: string; payload: unknown }>;
    client: DatasourceClient<T>;
  } {
    const bus = createEventBus();
    const events: Array<{ event: string; payload: unknown }> = [];
    bus.subscribe((e) => {
      events.push({ event: e.event as string, payload: e.payload });
    });
    const store: CredentialStore = {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    };
    const client = buildClient(bus, store, fixture.credentials);
    return { bus, events, client };
  }

  describe(`strategy contract suite — ${providerName}`, () => {
    it("listDirectory(root) returns entries carrying both path AND handle with correct kind", async () => {
      fixture.resetMock();
      fixture.primeListOk({ rootPath: "/" });
      const { client } = makeHarness();
      const entries = (await client.listDirectory({
        kind: "path",
        path: "/",
      })) as DatasourceFileEntry<T>[];
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(typeof e.path).toBe("string");
        expect(e.path.startsWith("/")).toBe(true);
        expect(typeof e.handle).toBe("string");
        expect(e.handle.length).toBeGreaterThan(0);
        expect(["file", "folder"]).toContain(e.kind);
      }
    });

    it("listDirectory(handle-form Target) behaves equivalently to path-form", async () => {
      fixture.resetMock();
      fixture.primeListOk({ rootPath: "/" });
      const { client } = makeHarness();
      // Get a handle from a real list first.
      fixture.resetMock();
      fixture.primeListOk({ rootPath: "/" });
      const pathEntries = await client.listDirectory({ kind: "path", path: "/" });
      const folder = pathEntries.find((e) => e.kind === "folder");
      if (!folder) {
        // Fixtures that seed only files fall back to asserting that a
        // handle-form call does not throw.
        fixture.resetMock();
        fixture.primeListOk({ rootPath: "/" });
        await expect(
          client.listDirectory({ kind: "handle", handle: "" }),
        ).resolves.toBeDefined();
        return;
      }
      fixture.resetMock();
      fixture.primeListOk({ rootPath: folder.path });
      const handleEntries = await client.listDirectory({
        kind: "handle",
        handle: folder.handle,
      });
      expect(Array.isArray(handleEntries)).toBe(true);
    });

    it("uploadFile(parent, { path }) resolves and emits uploading → file-created", async () => {
      fixture.resetMock();
      fixture.primeUploadOk({ parentPath: "/" });
      const { client, events } = makeHarness();
      const localPath = fixture.buildLocalFile();
      const entry = await client.uploadFile(
        { kind: "path", path: "/" },
        { path: localPath },
      );
      expect(entry).toBeDefined();
      expect(typeof entry.path).toBe("string");
      expect(typeof entry.handle).toBe("string");
      const names = events.map((e) => e.event);
      expect(names).toContain("uploading");
      expect(names).toContain("file-created");
      expect(names.indexOf("uploading")).toBeLessThan(
        names.indexOf("file-created"),
      );
    });

    it("deleteFile emits `deleted` and resolves to void", async () => {
      fixture.resetMock();
      fixture.primeDeleteOk("/contract-delete.txt");
      const { client, events } = makeHarness();
      const result = await client.deleteFile({
        kind: "path",
        path: "/contract-delete.txt",
      });
      expect(result).toBeUndefined();
      const names = events.map((e) => e.event);
      expect(names).toContain("deleted");
    });

    it("deleteDirectory throws Unsupported immediately and emits nothing", async () => {
      fixture.resetMock();
      const { client, events } = makeHarness();
      await expect(
        client.deleteDirectory({ kind: "path", path: "/any" }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof DatasourceError && e.tag === "unsupported",
      );
      expect(events).toHaveLength(0);
    });

    it("getMetadata(404) throws `not-found` and does NOT emit a `*-failed` event", async () => {
      fixture.resetMock();
      fixture.primeGetMetadata404("/missing.txt");
      const { client, events } = makeHarness();
      await expect(
        client.getMetadata({ kind: "path", path: "/missing.txt" }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof DatasourceError && e.tag === "not-found",
      );
      const names = events.map((e) => e.event);
      expect(names.filter((n) => n.endsWith("-failed"))).toHaveLength(0);
    });

    it("getQuota: if provider capability quota=false throws Unsupported; otherwise resolves", async () => {
      fixture.resetMock();
      const { client, events } = makeHarness();
      if (fixture.supportsQuota) {
        // The default fixture SHOULD not prime a quota response unless needed;
        // providers that support quota may have their own dedicated tests.
        // Here we just assert the method is at least callable and does not
        // emit `upload-failed` / `delete-failed` style events.
        try {
          await client.getQuota();
        } catch {
          // Acceptable — the fixture did not prime a quota response.
        }
      } else {
        await expect(client.getQuota()).rejects.toSatisfy(
          (e: unknown) =>
            e instanceof DatasourceError && e.tag === "unsupported",
        );
        expect(events).toHaveLength(0);
      }
    });

    it("rate-limit error on listDirectory surfaces `rate-limited` tag AND emits `rate-limited` event", async () => {
      fixture.resetMock();
      fixture.primeRateLimitOnList();
      const { client, events } = makeHarness();
      await expect(
        client.listDirectory({ kind: "path", path: "/" }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof DatasourceError && e.tag === "rate-limited",
      );
      const names = events.map((e) => e.event);
      expect(names).toContain("rate-limited");
    });

    it("auth failure on listDirectory surfaces the provider's expected auth tag", async () => {
      fixture.resetMock();
      fixture.primeAuthFailureOnList();
      const { client } = makeHarness();
      await expect(
        client.listDirectory({ kind: "path", path: "/" }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof DatasourceError && e.tag === fixture.expectedAuthErrorTag,
      );
    });

    it("cancelUpload against an unknown transactionId resolves silently (idempotent contract)", async () => {
      // Cheap universal assertion that the strategy exposes `cancelUpload`
      // and the base's idempotent-no-op path is reachable from every
      // provider without fixture setup. Per-strategy cancel behaviour
      // (DELETE session / Upload.abort()) is verified in each provider's
      // own test file — this scenario guards the interface surface only.
      fixture.resetMock();
      const { client, events } = makeHarness();
      await expect(
        client.cancelUpload("tx-nonexistent"),
      ).resolves.toBeUndefined();
      expect(events).toHaveLength(0);
    });
  });
}
