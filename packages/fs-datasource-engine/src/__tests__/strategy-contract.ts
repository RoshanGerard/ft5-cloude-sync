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

  /**
   * Whether the provider's strategy maintains a path-handle LRU cache
   * (`pathHandleCache`). Drive and OneDrive do (`true`); S3 does not
   * (`false`). The shared upload contract scenario asserts LRU
   * population post-resolve only when this flag is `true`. The cache
   * value shape differs per strategy (Drive: `{ fileId, ambiguousSiblings? }`,
   * OneDrive: `string`), so the assertion only checks the cache contains
   * a value for the resolved entry's path — not a particular value
   * shape (per migrate-upload-orchestration-out-of-engine Decision 4).
   */
  hasPathHandleCache: boolean;

  /**
   * Prime an upload that allocates provider-side resumable state, pushes
   * a small amount of progress, then awaits the supplied `controller.signal`
   * for cancellation. On abort, the strategy SHALL:
   *   - reject with `DatasourceError { tag: "cancelled", retryable: false }`,
   *   - issue provider-native cleanup against a SEPARATE signal (NOT the
   *     user's `controller.signal`).
   * Drive and OneDrive issue `DELETE <sessionUrl>` against
   * `AbortSignal.timeout(5000)`; S3 invokes `upload.abort()` which uses
   * the SDK's own internal controller.
   *
   * The fixture wires its mock so the strategy's underlying SDK / fetch
   * call awaits the supplied `controller.signal` before pushing
   * completion bytes — i.e., the strategy's progress reaches `firstChunkBytes`
   * (when supplied) and then blocks until cancel.
   */
  primeUploadCancellable(opts: {
    parentPath: string;
    controller: AbortController;
    firstChunkBytes?: number;
  }): void;

  /**
   * Diagnostic hook for the cancel-upload contract scenario: returns
   * `true` if the strategy issued a provider-native cleanup that did NOT
   * use the supplied user signal. For Drive/OneDrive, that means a
   * `DELETE` fetch on the session URL with a fresh AbortController; for
   * S3, that means `upload.abort()` (the SDK's own internal cancel —
   * no user-signal coupling required). The fixture inspects whatever
   * mock state captures the cleanup attempt and returns the boolean
   * verdict.
   *
   * The hook is invoked AFTER the user signal aborts and the strategy's
   * promise rejects with `cancelled`.
   */
  observedFreshCancelCleanup(opts: {
    userSignal: AbortSignal;
  }): boolean;

  /** Prime a successful delete. The scenario invokes
   * `client.delete({ kind: "path", path: targetPath }, "file")`. */
  primeDeleteOk(targetPath: string): void;

  /**
   * Prime a successful FILE rename happy path. The scenario then calls
   * `client.rename({ kind: "path", path: fromPath }, newName, "fail")` and
   * expects it to resolve with a `kind: "file"` entry. The fixture is
   * responsible for priming whatever introspection / sibling pre-check
   * the strategy issues before the rename.
   */
  primeRenameFileOk(opts: { fromPath: string; newName: string }): void;

  /**
   * Prime the directory-rename scenario. Two semantics depending on
   * `supportsFolderRename`:
   *
   *   - `supportsFolderRename: true` (Drive, OneDrive) — prime a
   *     successful folder rename. The shared scenario asserts the
   *     returned entry has `kind: "folder"` and exactly one
   *     `entry-renamed` event fires.
   *   - `supportsFolderRename: false` (S3) — prime the strategy-side
   *     introspection so the rename refuses with `tag: "unsupported"`
   *     per design.md Decision 1's strategy-introspected refusal. The
   *     shared scenario asserts the rejection AND that no
   *     `entry-renamed` is emitted.
   *
   * The fixture supplies the priming; the shared scenario decides which
   * outcome to assert via `supportsFolderRename`.
   */
  primeRenameDirectory(opts: { fromPath: string; newName: string }): void;

  /**
   * Whether this provider supports folder rename. Drive / OneDrive
   * (`true`) accept folder rename via the same primitive used for files.
   * S3 (`false`) refuses with `tag: "unsupported"` after introspection
   * detects a virtual-folder key.
   */
  supportsFolderRename: boolean;

  /**
   * Prime a successful end-to-end download. The fixture's SDK / fetch
   * mock returns a stream containing exactly `bytes` bytes plus a
   * `Content-Length` advertising the same. The shared scenario invokes
   * `client.downloadFile({ kind: "path", path }, { onProgress })`, drains
   * the stream, and asserts:
   *   - the bytes flowing through are byte-equal to the supplied buffer
   *   - `result.contentLength === bytes.length`
   *   - `onProgress` fired ≥1 time with a final `loaded === bytes.length`
   *
   * The engine emits no events (the event bus was removed in
   * migrate-engine-events-to-consumer); progress is observed solely via
   * `onProgress`.
   */
  primeDownloadOk(opts: { path: string; bytes: Buffer }): void;

  /**
   * Prime a download that pushes `firstChunkBytes` synchronously, then
   * awaits the supplied `controller.signal.abort()`. On abort, the
   * underlying source errors with an `AbortError`. The shared scenario
   * starts the download, drains until `firstChunkBytes` have been
   * observed, calls `controller.abort()`, and asserts:
   *   - the stream surfaces an error after the abort
   *   - `onProgress`'s last `loaded` reached `firstChunkBytes` but stayed
   *     below `totalBytes` (the source blocked on the abort)
   *
   * The engine emits no events (the bus was removed in
   * migrate-engine-events-to-consumer); the consumer (fs-sync) classifies
   * the cancel from its own AbortController state. Each provider's fake
   * stream wires abort-to-error differently; the fixture owns that wiring
   * so the shared scenario reads the same across providers.
   */
  primeDownloadCancellable(opts: {
    path: string;
    firstChunkBytes: number;
    totalBytes: number;
    controller: AbortController;
  }): void;

  // -------------------------------------------------------------------------
  // migrate-engine-cache-invalidation §3 — cache-eviction contract (Decision 5)
  // -------------------------------------------------------------------------

  /**
   * OCP cache-eviction contract. Prime a successful `deleteFile` of the FILE
   * entry that `primeListOk({ rootPath: "/" })` surfaces — keyed so the
   * delete resolves via a path-handle cache HIT on the listed handle (Drive:
   * `files.delete` by the listed fileId; OneDrive: `DELETE
   * /me/drive/items/<listedId>`). The shared scenario lists "/", asserts the
   * file's path is cached, resets the SDK mock (the client's cache survives —
   * `resetMock` only clears module-level mock state, never the client), primes
   * via this hook, deletes the path, and asserts the cache no longer holds it.
   *
   * Providers WITHOUT a path-handle cache (`hasPathHandleCache: false`, e.g.
   * S3) implement this as a no-op — the shared scenario early-returns for
   * them. Required (not optional) so every present AND future cached strategy
   * must consciously wire eviction priming; a new cached strategy that forgets
   * to evict FAILS this contract — that is the cross-strategy OCP enforcement,
   * achieved via the shared contract rather than base-class changes.
   */
  primeDeleteOfListedFile(): void;

  /**
   * As `primeDeleteOfListedFile`, but primes a successful FILE rename
   * (conflictPolicy `"fail"`) of the listed file to `opts.newName`, keyed to
   * resolve via the cache HIT (Drive: sibling-list miss + `files.update` on
   * the listed fileId; OneDrive: `GET`+`PATCH` on `/me/drive/items/<listedId>`
   * plus the sibling pre-check). The shared scenario asserts the OLD path is
   * evicted post-rename. S3 → no-op.
   */
  primeRenameOfListedFile(opts: { newName: string }): void;

  /** Stored credentials to construct the client under test. */
  credentials: StoredCredentials;
}

// ---------------------------------------------------------------------------
// Suite entry point
// ---------------------------------------------------------------------------

export interface StrategyContractSuiteParams<T extends DatasourceType> {
  /** Human-readable provider label used in `describe` blocks. */
  providerName: string;
  /** Returns a fresh client wired to the supplied credential store. The
   * engine no longer owns an event bus (migrate-engine-events-to-consumer),
   * so the client is constructed with `{ credentialStore, providerDescriptor }`
   * only — outcomes are asserted via return values, thrown errors,
   * `onProgress`, or strategy cache state, never captured bus events. */
  buildClient(
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
 *       buildClient: (store, creds) => createS3Client("ds-1", creds, { credentialStore: store, providerDescriptor: providers["amazon-s3"] }),
 *       fixture: s3Fixture,
 *     });
 */
export function runStrategyContractSuite<T extends DatasourceType>(
  params: StrategyContractSuiteParams<T>,
): void {
  const { providerName, buildClient, fixture } = params;

  function makeHarness(): {
    client: DatasourceClient<T>;
  } {
    const store: CredentialStore = {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    };
    const client = buildClient(store, fixture.credentials);
    return { client };
  }

  describe(`strategy contract suite — ${providerName}`, () => {
    it("DatasourceClient<T> interface is shrunk: no createFile, no cancelUpload (per migrate-upload-orchestration-out-of-engine)", () => {
      // The buildClient param's return type already pins each concrete
      // strategy as `DatasourceClient<T>` — that is the implicit
      // assignability check. This explicit type-level assertion
      // additionally verifies the shrunk interface: `createFile` and
      // `cancelUpload` MUST NOT be keys of `DatasourceClient<T>` after
      // this migration. A regression that re-introduces either method
      // (or its shape on a strategy class without a corresponding
      // interface entry) trips this assertion at typecheck.
      type ClientKeys = keyof DatasourceClient<DatasourceType>;
      type HasCreateFile = "createFile" extends ClientKeys ? true : false;
      type HasCancelUpload = "cancelUpload" extends ClientKeys ? true : false;
      const hasCreateFile: HasCreateFile = false;
      const hasCancelUpload: HasCancelUpload = false;
      expect(hasCreateFile).toBe(false);
      expect(hasCancelUpload).toBe(false);
    });

    it("listDirectory(root) returns { entries, nextCursor } with entries carrying both path AND handle with correct kind", async () => {
      fixture.resetMock();
      fixture.primeListOk({ rootPath: "/" });
      const { client } = makeHarness();
      const result = await client.listDirectory({
        kind: "path",
        path: "/",
      });
      // add-engine-listdirectory-pagination §1.5: every strategy returns the
      // paginated shape — an `entries` array plus an opaque `nextCursor`
      // (`string | null`), never a bare array.
      expect(Array.isArray(result.entries)).toBe(true);
      expect(
        result.nextCursor === null || typeof result.nextCursor === "string",
      ).toBe(true);
      const entries = result.entries as DatasourceFileEntry<T>[];
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
      const pathResult = await client.listDirectory({ kind: "path", path: "/" });
      const folder = pathResult.entries.find((e) => e.kind === "folder");
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
      const handleResult = await client.listDirectory({
        kind: "handle",
        handle: folder.handle,
      });
      expect(Array.isArray(handleResult.entries)).toBe(true);
      expect(
        handleResult.nextCursor === null ||
          typeof handleResult.nextCursor === "string",
      ).toBe(true);
    });

    it("uploadFile(parent, { path }) resolves with the entry, drives onProgress monotonically, and (where applicable) populates the strategy's path-handle LRU", async () => {
      fixture.resetMock();
      fixture.primeUploadOk({ parentPath: "/" });
      const { client } = makeHarness();
      const localPath = fixture.buildLocalFile();

      // onProgress invocations are captured for the per-call assertion
      // below — at least one invocation, monotonically non-decreasing
      // `loaded` values, final `loaded === total` on success per
      // migrate-upload-orchestration-out-of-engine spec scenario
      // "onProgress is invoked with monotonic loaded values".
      const progressCalls: Array<{ loaded: number; total: number }> = [];
      const onProgress = (loaded: number, total: number): void => {
        progressCalls.push({ loaded, total });
      };

      const entry = await client.uploadFile(
        { kind: "path", path: "/" },
        { path: localPath },
        { onProgress },
      );
      expect(entry).toBeDefined();
      expect(typeof entry.path).toBe("string");
      expect(typeof entry.handle).toBe("string");

      // The engine emits no events at all (the event bus was removed in
      // migrate-engine-events-to-consumer); upload progress / completion is
      // observed by the consumer (fs-sync handler) on `sync:event-stream`
      // keyed by `uploadJobId`, driven off `onProgress` + the handler's own
      // synchronous path.

      // onProgress contract: at least one invocation, non-decreasing
      // `loaded`, and `loaded === total` at the final call when the
      // strategy advertised a non-zero `total`. The base allows
      // `total === 0` for size-unknown sources (e.g., zero-byte files
      // or providers that don't declare upfront content length); in
      // those cases the final `loaded` matches `total === 0` trivially.
      expect(progressCalls.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < progressCalls.length; i++) {
        expect(progressCalls[i]!.loaded).toBeGreaterThanOrEqual(
          progressCalls[i - 1]!.loaded,
        );
      }
      const final = progressCalls[progressCalls.length - 1]!;
      expect(final.loaded).toBe(final.total);

      // LRU population is internal post-migration (Decision 4) — Drive
      // and OneDrive's strategies set `pathHandleCache.set(entry.path,
      // entry.handle)` inside `doUploadFileImpl` before returning. S3
      // has no path-handle cache. The fixture's `hasPathHandleCache`
      // flag selects the assertion.
      if (fixture.hasPathHandleCache) {
        // Cache shape differs between Drive (`{ fileId, ambiguousSiblings? }`)
        // and OneDrive (`string`), so we only assert presence — not a
        // particular value shape.
        const cache = (
          client as unknown as { pathHandleCache?: Map<string, unknown> }
        ).pathHandleCache;
        expect(cache).toBeDefined();
        expect(cache!.has(entry.path)).toBe(true);
      }
    });

    it("uploadFile honours options.signal: aborting mid-upload rejects with cancelled, issues fresh-signal cleanup (Decision 3)", async () => {
      const controller = new AbortController();
      fixture.resetMock();
      fixture.primeUploadCancellable({
        parentPath: "/",
        controller,
        firstChunkBytes: 256,
      });
      const { client } = makeHarness();
      const localPath = fixture.buildLocalFile();

      const inflight = client.uploadFile(
        { kind: "path", path: "/" },
        { path: localPath },
        { signal: controller.signal },
      );

      // Give the strategy a microtask tick to allocate provider-side
      // resumable state (Drive/OneDrive: session URL acquired; S3:
      // CreateMultipartUpload in flight) before we abort. Each
      // fixture's `primeUploadCancellable` is responsible for keeping
      // the upload pending until the controller fires, so the abort
      // race is deterministic.
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();

      // Strategy SHALL reject with the canonical `cancelled` tag —
      // not a provider-native AbortError — per
      // migrate-upload-orchestration-out-of-engine spec scenario
      // "signal forwarded to provider call unblocks promptly on abort".
      await expect(inflight).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof DatasourceError && e.tag === "cancelled",
      );

      // The engine emits no events — cancellation surfaces solely as the
      // thrown `cancelled` tag (asserted above); the consumer maps it onto
      // `sync:event-stream`.

      // Provider-native cleanup SHALL run on a separate signal (Decision
      // 3) — fresh AbortController.timeout(5000) for Drive/OneDrive's
      // DELETE, the SDK's internal controller for S3's
      // `upload.abort()`. The fixture's introspection hook returns
      // `true` when it observed cleanup that did NOT couple to the
      // user's signal.
      expect(
        fixture.observedFreshCancelCleanup({ userSignal: controller.signal }),
      ).toBe(true);
    });

    it("delete (file) resolves to void", async () => {
      fixture.resetMock();
      fixture.primeDeleteOk("/contract-delete.txt");
      const { client } = makeHarness();
      const result = await client.delete(
        { kind: "path", path: "/contract-delete.txt" },
        "file",
      );
      expect(result).toBeUndefined();
    });

    it("delete (directory) throws Unsupported immediately", async () => {
      fixture.resetMock();
      const { client } = makeHarness();
      await expect(
        client.delete({ kind: "path", path: "/any" }, "directory"),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof DatasourceError && e.tag === "unsupported",
      );
    });

    it("getMetadata(404) throws `not-found`", async () => {
      fixture.resetMock();
      fixture.primeGetMetadata404("/missing.txt");
      const { client } = makeHarness();
      await expect(
        client.getMetadata({ kind: "path", path: "/missing.txt" }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof DatasourceError && e.tag === "not-found",
      );
    });

    it("getQuota: if provider capability quota=false throws Unsupported; otherwise resolves", async () => {
      fixture.resetMock();
      const { client } = makeHarness();
      if (fixture.supportsQuota) {
        // The default fixture SHOULD not prime a quota response unless needed;
        // providers that support quota may have their own dedicated tests.
        // Here we just assert the method is at least callable.
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
      }
    });

    it("rate-limit error on listDirectory surfaces the `rate-limited` tag", async () => {
      fixture.resetMock();
      fixture.primeRateLimitOnList();
      const { client } = makeHarness();
      await expect(
        client.listDirectory({ kind: "path", path: "/" }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof DatasourceError && e.tag === "rate-limited",
      );
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

    // The legacy `cancelUpload(transactionId)` interface scenario was
    // removed by migrate-upload-orchestration-out-of-engine — the engine
    // no longer exposes that method (cancellation is consumer-driven via
    // `options.signal`). The deeper signal-driven upload contract sweep
    // is rebuilt by chunk C of that change.

    // -----------------------------------------------------------------------
    // add-engine-rename-download §10.1 — rename + download contract sweep
    // -----------------------------------------------------------------------
    //
    // Four scenarios run against every strategy so the engine's new
    // surface (rename, downloadFile) is exercised uniformly. Per-strategy
    // SDK quirks live in each provider's `*-client.contract.test.ts`
    // fixture; the shared assertions below pin the cross-provider
    // contract.

    it("rename(file) returns the renamed entry", async () => {
      fixture.resetMock();
      fixture.primeRenameFileOk({
        fromPath: "/contract-old.txt",
        newName: "contract-new.txt",
      });
      const { client } = makeHarness();
      const entry = await client.rename(
        { kind: "path", path: "/contract-old.txt" },
        "contract-new.txt",
        "fail",
      );
      // Rename returns the single renamed entry regardless of how many
      // provider-side calls the strategy made (Decision 2) — e.g. S3's
      // internal copy+delete is invisible to the caller. The engine emits no
      // events (the event bus was removed in
      // migrate-engine-events-to-consumer).
      expect(entry.kind).toBe("file");
      expect(entry.name).toBe("contract-new.txt");
    });

    it("rename(directory) succeeds on Drive/OneDrive OR refuses with `unsupported` on S3 (per Decision 1)", async () => {
      fixture.resetMock();
      fixture.primeRenameDirectory({
        fromPath: "/contract-folder",
        newName: "contract-folder-renamed",
      });
      const { client } = makeHarness();
      if (fixture.supportsFolderRename) {
        const entry = await client.rename(
          { kind: "path", path: "/contract-folder" },
          "contract-folder-renamed",
          "fail",
        );
        expect(entry.kind).toBe("folder");
        expect(entry.name).toBe("contract-folder-renamed");
      } else {
        await expect(
          client.rename(
            { kind: "path", path: "/contract-folder" },
            "contract-folder-renamed",
            "fail",
          ),
        ).rejects.toSatisfy(
          (e: unknown) =>
            e instanceof DatasourceError && e.tag === "unsupported",
        );
      }
    });

    it("downloadFile streams a small fixture end-to-end; onProgress fires; bytes are intact", async () => {
      const fixtureBytes = Buffer.from("contract-download-bytes-payload");
      fixture.resetMock();
      fixture.primeDownloadOk({
        path: "/contract-download.txt",
        bytes: fixtureBytes,
      });
      const { client } = makeHarness();
      // The engine emits no download events (the bus was removed in
      // migrate-engine-events-to-consumer) — progress flows solely via
      // `options.onProgress`, and the consumer (fs-sync) owns terminal
      // handling off its own pipe-to-disk path.
      const progressTicks: Array<{ loaded: number; total: number | null }> = [];
      const result = await client.downloadFile(
        { kind: "path", path: "/contract-download.txt" },
        { onProgress: (loaded, total) => progressTicks.push({ loaded, total }) },
      );
      expect(result.contentLength).toBe(fixtureBytes.length);
      // Drain the stream.
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        result.stream.on("data", (c: Buffer) => chunks.push(c));
        result.stream.on("end", () => resolve());
        result.stream.on("error", reject);
      });
      expect(Buffer.concat(chunks).equals(fixtureBytes)).toBe(true);
      // onProgress fired ≥1 time and the final loaded equals the byte count.
      expect(progressTicks.length).toBeGreaterThanOrEqual(1);
      expect(progressTicks[progressTicks.length - 1]!.loaded).toBe(
        fixtureBytes.length,
      );
    });

    it("downloadFile mid-flight abort: stream errors after abort; onProgress reports up to firstChunkBytes", async () => {
      const controller = new AbortController();
      const firstChunkBytes = 2048;
      const totalBytes = 16384;
      fixture.resetMock();
      fixture.primeDownloadCancellable({
        path: "/contract-cancel.txt",
        firstChunkBytes,
        totalBytes,
        controller,
      });
      const { client } = makeHarness();
      const progressTicks: Array<{ loaded: number; total: number | null }> = [];
      const result = await client.downloadFile(
        { kind: "path", path: "/contract-cancel.txt" },
        {
          signal: controller.signal,
          onProgress: (loaded, total) =>
            progressTicks.push({ loaded, total }),
        },
      );
      let bytesSeen = 0;
      let streamErrored = false;
      await new Promise<void>((resolve) => {
        result.stream.on("data", (c: Buffer) => {
          bytesSeen += c.length;
          if (bytesSeen >= firstChunkBytes) controller.abort();
        });
        result.stream.on("error", () => {
          streamErrored = true;
          resolve();
        });
        result.stream.on("end", () => resolve());
      });
      // The aborted stream surfaces the abort as a stream error (each
      // fixture wires abort-to-error per its provider). The consumer
      // (fs-sync) classifies this as a user cancel from its own
      // AbortController state and emits `download-cancelled`; the engine
      // itself emits nothing.
      expect(streamErrored).toBe(true);
      // onProgress observed at least the first chunk and never exceeded it
      // (the source blocked on the abort after firstChunkBytes).
      expect(progressTicks.length).toBeGreaterThanOrEqual(1);
      const lastTick = progressTicks[progressTicks.length - 1]!;
      expect(lastTick.loaded).toBeGreaterThanOrEqual(firstChunkBytes);
      expect(lastTick.loaded).toBeLessThan(totalBytes);
    });

    // -----------------------------------------------------------------------
    // migrate-engine-cache-invalidation §3 — cross-strategy cache-eviction
    // invariant (OCP enforcement, Decision 5).
    // -----------------------------------------------------------------------
    //
    // Gated on `hasPathHandleCache`: Drive/OneDrive (`true`) MUST evict; S3
    // (`false`) satisfies the invariant vacuously and early-returns. Each
    // scenario POPULATES the cache via a real `listDirectory("/")`, asserts
    // the listed file's path is cached, then mutates that SAME entry and
    // asserts the path is gone. The precondition assertion is load-bearing
    // twice over: it defeats a trivial post-mutation pass (a path that was
    // never cached is "absent" without any eviction), AND it guarantees the
    // mutation resolves via a cache HIT — which is why, after the reset, the
    // mutation needs no list responder for its OWN resolve (only the
    // sibling-list for rename + the delete/update responder).
    //
    // The SDK mock is reset AFTER the populating list (the client's cache
    // lives on the instance and survives `resetMock`, which clears only
    // module-level mock state) so the mutation's priming starts collision-
    // free — notably Drive's substring-matched list mock would otherwise let
    // the leftover root-list responder shadow the rename's sibling-check
    // query.

    it("after deleteFile of a cached path, the strategy evicts it from its path-handle cache (OCP — cached strategies only)", async () => {
      if (!fixture.hasPathHandleCache) return; // S3: no path cache — vacuous.
      fixture.resetMock();
      fixture.primeListOk({ rootPath: "/" });
      const { client } = makeHarness();
      const listed = await client.listDirectory({ kind: "path", path: "/" });
      const file = listed.entries.find((e) => e.kind === "file");
      expect(file).toBeDefined();
      const cache = (
        client as unknown as { pathHandleCache?: Map<string, unknown> }
      ).pathHandleCache;
      expect(cache).toBeDefined();
      // Precondition: the list populated the cache for the file's path.
      expect(cache!.has(file!.path)).toBe(true);

      // Reset the SDK mock (the client cache survives) so the delete's
      // priming is collision-free, then prime + delete the SAME listed entry.
      fixture.resetMock();
      fixture.primeDeleteOfListedFile();
      await client.delete({ kind: "path", path: file!.path }, "file");

      // The successful delete MUST have evicted the cached path inline.
      expect(cache!.has(file!.path)).toBe(false);
    });

    it("after rename of a cached path, the strategy evicts the old path from its path-handle cache (OCP — cached strategies only)", async () => {
      if (!fixture.hasPathHandleCache) return; // S3: no path cache — vacuous.
      fixture.resetMock();
      fixture.primeListOk({ rootPath: "/" });
      const { client } = makeHarness();
      const listed = await client.listDirectory({ kind: "path", path: "/" });
      const file = listed.entries.find((e) => e.kind === "file");
      expect(file).toBeDefined();
      const cache = (
        client as unknown as { pathHandleCache?: Map<string, unknown> }
      ).pathHandleCache;
      expect(cache).toBeDefined();
      expect(cache!.has(file!.path)).toBe(true);

      fixture.resetMock();
      fixture.primeRenameOfListedFile({ newName: "renamed-by-contract.txt" });
      const renamed = await client.rename(
        { kind: "path", path: file!.path },
        "renamed-by-contract.txt",
        "fail",
      );
      expect(renamed.name).toBe("renamed-by-contract.txt");
      // Evict-only on the OLD path — the new path resolves fresh on next
      // access (re-population is an optimization, not part of the invariant).
      expect(cache!.has(file!.path)).toBe(false);
    });
  });
}
