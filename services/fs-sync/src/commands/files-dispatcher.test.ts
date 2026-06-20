// Task 2.6 — end-to-end dispatcher integration test.
//
// Builds the full `buildCommandHandlers` map with a fake `resolveClient`
// returning an in-memory fake engine client. Asserts every `files:*`
// command routes to the right engine method and returns the envelope
// shape the IPC contract promises.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatasourceClient } from "@ft5/fs-datasource-engine";
import type { DatasourceFileEntry, DatasourceType } from "@ft5/ipc-contracts";

import { applyMigrations } from "../db/migrations.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import type { CommandHandlers } from "../ipc/server.js";

import { buildCommandHandlers } from "./handlers.js";

let cleanup: string[] = [];
let db: Database.Database;
let bus: EventBus;
let handlers: CommandHandlers;
let fakeClient: DatasourceClient<DatasourceType>;

function makeFakeClient(): DatasourceClient<DatasourceType> {
  return {
    type: "google-drive",
    datasourceId: "ds-fake",
    status: vi.fn(),
    testConnection: vi.fn(),
    authenticate: vi.fn(),
    listDirectory: vi.fn(),
    search: vi.fn(),
    getMetadata: vi.fn(),
    createFile: vi.fn(),
    uploadFile: vi.fn(),
    cancelUpload: vi.fn(),
    delete: vi.fn(),
    getQuota: vi.fn(),
    // Required on DatasourceClient after migrate-engine-retry-policy-to-consumer;
    // the wrapped handlers call it only on an `auth-expired` path (none here),
    // but it is stubbed for runtime-safety since the casts bypass the compile check.
    refreshCredentials: vi
      .fn()
      .mockResolvedValue({ accessToken: "new", refreshToken: "r" }),
  } as DatasourceClient<DatasourceType>;
}

function makeEngineEntry(
  over: Partial<DatasourceFileEntry<"google-drive">> = {},
): DatasourceFileEntry<"google-drive"> {
  return {
    handle: "h-notes",
    kind: "file",
    name: "notes.txt",
    path: "/notes.txt",
    size: 42,
    mimeFamily: "document",
    modifiedAt: Date.parse("2026-04-01T00:00:00.000Z"),
    providerMetadata: {},
    ...over,
  };
}

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

beforeEach(() => {
  const file = path.join(
    os.tmpdir(),
    `ft5-sync-files-dispatcher-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  cleanup.push(file);
  db = new Database(file);
  applyMigrations(db);
  bus = createEventBus();
  fakeClient = makeFakeClient();
  handlers = buildCommandHandlers({
    db,
    bus,
    serviceVersion: "0.0.0-test",
    serviceUuid: "test-uuid",
    resolveClient: async () => fakeClient,
  });
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    /* tolerated */
  }
  for (const f of cleanup) {
    try {
      await fsp.rm(f, { force: true });
    } catch {
      /* tolerated */
    }
  }
  cleanup = [];
});

describe("files:* dispatcher integration", () => {
  it("all four commands are registered when resolveClient is provided", () => {
    expect(handlers["files:list"]).toBeDefined();
    expect(handlers["files:stat"]).toBeDefined();
    expect(handlers["files:search"]).toBeDefined();
    expect(handlers["files:remove"]).toBeDefined();
  });

  it("none of the files:* handlers are registered when resolveClient is absent", () => {
    const noEngineHandlers = buildCommandHandlers({
      db,
      bus,
      serviceVersion: "0.0.0-test",
      serviceUuid: "test-uuid",
    });
    expect(noEngineHandlers["files:list"]).toBeUndefined();
    expect(noEngineHandlers["files:stat"]).toBeUndefined();
    expect(noEngineHandlers["files:search"]).toBeUndefined();
    expect(noEngineHandlers["files:remove"]).toBeUndefined();
  });

  it("files:list end-to-end: dispatcher → engine.listDirectory → envelope with mapped UI entries + nextCursor", async () => {
    // Post add-engine-listdirectory-pagination the engine resolves
    // `{ entries, nextCursor }` and the handler forwards a cursor/pageSize
    // options object (both undefined on a first-page request) + derives
    // `truncated = nextCursor !== null`.
    const engineEntry = makeEngineEntry({ handle: "h-a", path: "/notes.txt" });
    (fakeClient.listDirectory as ReturnType<typeof vi.fn>).mockResolvedValue({
      entries: [engineEntry],
      nextCursor: null,
    });

    const h = handlers["files:list"]!;
    const result = await h({ datasourceId: "ds-1", path: "/" }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.truncated).toBe(false);
      expect(result.result.nextCursor).toBeNull();
      expect(result.result.entries).toHaveLength(1);
      expect(result.result.entries[0]!.id).toBe("h-a");
      expect(result.result.entries[0]!.path).toBe("/notes.txt");
    }
    expect(fakeClient.listDirectory).toHaveBeenCalledWith(
      { kind: "path", path: "/" },
      { cursor: undefined, pageSize: undefined },
    );
  });

  it("files:stat end-to-end: dispatcher → engine.getMetadata → envelope with mapped UI entry", async () => {
    const engineEntry = makeEngineEntry({
      handle: "h-y",
      path: "/x/y.txt",
      name: "y.txt",
    });
    (fakeClient.getMetadata as ReturnType<typeof vi.fn>).mockResolvedValue(
      engineEntry,
    );

    const h = handlers["files:stat"]!;
    const result = await h({ datasourceId: "ds-1", path: "/x/y.txt" }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.entry.id).toBe("h-y");
      expect(result.result.entry.name).toBe("y.txt");
      expect(result.result.entry.parentPath).toBe("/x");
    }
    expect(fakeClient.getMetadata).toHaveBeenCalledWith({
      kind: "path",
      path: "/x/y.txt",
    });
  });

  it("files:search end-to-end: dispatcher forwards query + scope and maps hits to UI entries", async () => {
    const hit = makeEngineEntry({
      handle: "h-budget",
      name: "budget.xlsx",
      path: "/p/budget.xlsx",
    });
    (fakeClient.search as ReturnType<typeof vi.fn>).mockResolvedValue([hit]);

    const h = handlers["files:search"]!;
    const result = await h(
      { datasourceId: "ds-1", query: "budget", path: "/p" },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.truncated).toBe(false);
      expect(result.result.entries).toHaveLength(1);
      expect(result.result.entries[0]!.id).toBe("h-budget");
      expect(result.result.entries[0]!.name).toBe("budget.xlsx");
    }
    expect(fakeClient.search).toHaveBeenCalledWith("budget", {
      kind: "path",
      path: "/p",
    });
  });

  it("files:remove end-to-end: dispatcher fans out to delete by handle with allSettled (no getMetadata round-trip)", async () => {
    (fakeClient.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const h = handlers["files:remove"]!;
    const result = await h(
      {
        datasourceId: "ds-1",
        targets: [
          { path: "/a", handle: "h-a", kind: "file" },
          { path: "/b", handle: "h-b", kind: "file" },
        ],
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.results).toEqual([
        { path: "/a", handle: "h-a", ok: true },
        { path: "/b", handle: "h-b", ok: true },
      ]);
    }
    expect(fakeClient.delete).toHaveBeenCalledTimes(2);
    // Handle-based addressing skips the ambiguity-vulnerable getMetadata call.
    expect(fakeClient.getMetadata).not.toHaveBeenCalled();
    expect(fakeClient.delete).toHaveBeenCalledWith(
      {
        kind: "handle",
        handle: "h-a",
      },
      "file",
    );
    expect(fakeClient.delete).toHaveBeenCalledWith(
      {
        kind: "handle",
        handle: "h-b",
      },
      "file",
    );
  });
});
