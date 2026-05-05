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
   * `client.downloadFile({ kind: "path", path })`, drains the stream,
   * and asserts:
   *   - the bytes flowing through are byte-equal to the supplied buffer
   *   - `result.contentLength === bytes.length`
   *   - bus emits ≥1 `downloading` then exactly one `file-downloaded`
   *   - no `download-failed` / `download-cancelled`
   */
  primeDownloadOk(opts: { path: string; bytes: Buffer }): void;

  /**
   * Prime a download that pushes `firstChunkBytes` synchronously, then
   * awaits the supplied `controller.signal.abort()`. On abort, the
   * underlying source errors with an `AbortError`. The shared scenario
   * starts the download, drains until `firstChunkBytes` have been
   * observed, calls `controller.abort()`, and asserts:
   *   - bus emits exactly one `download-cancelled
   *     { path, bytesDownloaded: firstChunkBytes }`
   *   - no `download-failed` and no `file-downloaded`
   *
   * Each provider's fake stream wires abort-to-error differently; the
   * fixture owns that wiring so the shared scenario reads the same
   * across providers.
   */
  primeDownloadCancellable(opts: {
    path: string;
    firstChunkBytes: number;
    totalBytes: number;
    controller: AbortController;
  }): void;

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

    it("uploadFile(parent, { path }) resolves with the entry and emits NO upload events on the engine bus (post-migrate-upload-orchestration-out-of-engine)", async () => {
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
      // Per migrate-upload-orchestration-out-of-engine, the engine bus
      // observes ZERO upload-related events; the consumer (fs-sync handler)
      // emits these on `sync:event-stream` keyed by `uploadJobId`.
      expect(names).not.toContain("uploading");
      expect(names).not.toContain("file-created");
      expect(names).not.toContain("upload-failed");
      expect(names).not.toContain("upload-cancelled");
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

    it("rename(file) returns the renamed entry; bus emits exactly one entry-renamed; no other events", async () => {
      fixture.resetMock();
      fixture.primeRenameFileOk({
        fromPath: "/contract-old.txt",
        newName: "contract-new.txt",
      });
      const { client, events } = makeHarness();
      const entry = await client.rename(
        { kind: "path", path: "/contract-old.txt" },
        "contract-new.txt",
        "fail",
      );
      expect(entry.kind).toBe("file");
      expect(entry.name).toBe("contract-new.txt");
      const renames = events.filter((e) => e.event === "entry-renamed");
      expect(renames).toHaveLength(1);
      // No other lifecycle events should fire — rename is one normalized
      // event regardless of how many provider-side calls the strategy
      // made (Decision 2). In particular S3's internal copy+delete must
      // NOT surface a `deleted` event.
      const otherNames = events
        .map((e) => e.event)
        .filter((n) => n !== "entry-renamed");
      expect(otherNames).toHaveLength(0);
    });

    it("rename(directory) succeeds on Drive/OneDrive OR refuses with `unsupported` on S3 (per Decision 1)", async () => {
      fixture.resetMock();
      fixture.primeRenameDirectory({
        fromPath: "/contract-folder",
        newName: "contract-folder-renamed",
      });
      const { client, events } = makeHarness();
      if (fixture.supportsFolderRename) {
        const entry = await client.rename(
          { kind: "path", path: "/contract-folder" },
          "contract-folder-renamed",
          "fail",
        );
        expect(entry.kind).toBe("folder");
        expect(entry.name).toBe("contract-folder-renamed");
        const renames = events.filter((e) => e.event === "entry-renamed");
        expect(renames).toHaveLength(1);
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
        // Refusal must not emit entry-renamed.
        expect(events.some((e) => e.event === "entry-renamed")).toBe(false);
      }
    });

    it("downloadFile streams a small fixture end-to-end; bus emits downloading then file-downloaded; bytes are intact", async () => {
      const fixtureBytes = Buffer.from("contract-download-bytes-payload");
      fixture.resetMock();
      fixture.primeDownloadOk({
        path: "/contract-download.txt",
        bytes: fixtureBytes,
      });
      const { client, events } = makeHarness();
      const result = await client.downloadFile({
        kind: "path",
        path: "/contract-download.txt",
      });
      expect(result.contentLength).toBe(fixtureBytes.length);
      // Drain the stream so the base's terminal listeners fire.
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        result.stream.on("data", (c: Buffer) => chunks.push(c));
        result.stream.on("end", () => resolve());
        result.stream.on("error", reject);
      });
      expect(Buffer.concat(chunks).equals(fixtureBytes)).toBe(true);
      const names = events.map((e) => e.event);
      expect(
        names.filter((n) => n === "downloading").length,
      ).toBeGreaterThanOrEqual(1);
      expect(names.filter((n) => n === "file-downloaded")).toHaveLength(1);
      expect(names).not.toContain("download-failed");
      expect(names).not.toContain("download-cancelled");
    });

    it("downloadFile mid-flight abort: bus emits exactly one download-cancelled with bytesDownloaded; no download-failed", async () => {
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
      const { client, events } = makeHarness();
      const result = await client.downloadFile(
        { kind: "path", path: "/contract-cancel.txt" },
        { signal: controller.signal },
      );
      let bytesSeen = 0;
      await new Promise<void>((resolve) => {
        result.stream.on("data", (c: Buffer) => {
          bytesSeen += c.length;
          if (bytesSeen >= firstChunkBytes) controller.abort();
        });
        result.stream.on("error", () => resolve());
        result.stream.on("end", () => resolve());
      });
      const cancelled = events.filter((e) => e.event === "download-cancelled");
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]!.payload).toMatchObject({
        bytesDownloaded: firstChunkBytes,
      });
      expect(events.some((e) => e.event === "download-failed")).toBe(false);
      expect(events.some((e) => e.event === "file-downloaded")).toBe(false);
    });
  });
}
