import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations } from "../db/migrations.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import { SnapshotRepository } from "../jobs/snapshot-repository.js";
import type { Executor, ExecutorCtx } from "../scheduler/scheduler.js";

import { buildMirrorSyncExecutor } from "./mirror-sync.js";

let cleanup: string[] = [];
let db: Database.Database;
let bus: EventBus;
let emitted: Array<{ name: string; payload: unknown }>;
let root: string;

beforeEach(async () => {
  const file = path.join(
    os.tmpdir(),
    `ft5-sync-mirror-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  cleanup.push(file);
  db = new Database(file);
  applyMigrations(db);
  bus = createEventBus();
  emitted = [];
  bus.subscribe((name, payload) => {
    emitted.push({ name, payload });
  });
  root = path.join(
    os.tmpdir(),
    `ft5-sync-mirror-src-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  cleanup.push(root);
  await fsp.mkdir(root, { recursive: true });
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    /* tolerated */
  }
  for (const f of cleanup) {
    try {
      await fsp.rm(f, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
  cleanup = [];
});

function ctxFor(sourcePath: string, conflictPolicy: "overwrite" | "skip" = "overwrite"): ExecutorCtx {
  return {
    job: {
      id: "j-1",
      kind: "sync",
      datasourceId: "ds-1",
      sourcePath,
      targetPath: null,
      conflictPolicy,
      status: "running",
      attempt: 1,
      lastErrorTag: null,
      lastErrorMessage: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    signal: new AbortController().signal,
    bus,
  };
}

function fakeClient() {
  const uploadFile = vi.fn(async (parent: unknown) => ({
    id: `remote-${Math.random().toString(36).slice(2)}`,
    name: "x",
    path: (parent as { path?: string }).path ?? "",
    size: 0,
    kind: "file" as const,
  }));
  const deleteFile = vi.fn(async () => void 0);
  return { client: { uploadFile, deleteFile }, uploadFile, deleteFile };
}

describe("MirrorSyncJobExecutor — source-health precondition", () => {
  it("fails with tag='source-unavailable' and emits event when source missing", async () => {
    const { client, uploadFile, deleteFile } = fakeClient();
    // Seed snapshot to prove zero remote calls are made on unavailable source.
    const snaps = new SnapshotRepository(db);
    for (let i = 0; i < 50; i++) {
      snaps.upsert("ds-1", {
        relPath: `seeded-${i}.txt`,
        size: 1,
        mtimeMs: 1,
        sha256: "x",
        remoteHandle: `h-${i}`,
      });
    }
    const exec: Executor = buildMirrorSyncExecutor({
      db,
      resolveClient: async () => client as never,
    });
    const res = await exec(ctxFor("/does/not/exist"));
    expect(res.outcome).toBe("failed");
    if (res.outcome === "failed") expect(res.errorTag).toBe("source-unavailable");
    expect(uploadFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    expect(emitted.map((e) => e.name)).toContain("source-unavailable");
    // Snapshot rows untouched.
    expect(snaps.listForDatasource("ds-1")).toHaveLength(50);
  });
});

describe("MirrorSyncJobExecutor — end-to-end", () => {
  async function seed(rel: string, content = "x"): Promise<void> {
    const full = path.join(root, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content);
  }

  it("uploads a new file and writes a sync_snapshot row; emits sync-completed with counts", async () => {
    await seed("a.txt", "hello");
    const { client, uploadFile } = fakeClient();
    const exec: Executor = buildMirrorSyncExecutor({
      db,
      resolveClient: async () => client as never,
      hashFile: async () => "hash-a",
    });
    const res = await exec(ctxFor(root));
    expect(res.outcome).toBe("completed");
    expect(uploadFile).toHaveBeenCalledTimes(1);
    // migrate-upload-orchestration-out-of-engine §12.1 — the executor
    // forwards its AbortSignal to client.uploadFile via the new options
    // arg; assert the call shape so a future regression that drops the
    // signal is caught.
    const [parent, file, options] = uploadFile.mock.calls[0];
    expect(parent).toMatchObject({ kind: "path" });
    expect(file).toMatchObject({ path: expect.stringContaining("a.txt") });
    expect(options).toBeDefined();
    expect((options as { signal?: AbortSignal }).signal).toBeInstanceOf(
      AbortSignal,
    );
    const completed = emitted.find((e) => e.name === "sync-completed");
    expect(completed).toBeTruthy();
    expect(completed?.payload).toMatchObject({
      uploaded: 1,
      updated: 0,
      deleted: 0,
      skipped: 0,
    });

    const snaps = new SnapshotRepository(db).listForDatasource("ds-1");
    expect(snaps.map((s) => s.relPath)).toEqual(["a.txt"]);
  });

  it("propagates remote delete for locally-removed entries", async () => {
    const snaps = new SnapshotRepository(db);
    snaps.upsert("ds-1", {
      relPath: "ghost.txt",
      size: 1,
      mtimeMs: 100,
      sha256: "h",
      remoteHandle: "r-ghost",
    });
    await seed("still-here.txt", "ok");

    const { client, uploadFile, deleteFile } = fakeClient();
    const exec = buildMirrorSyncExecutor({
      db,
      resolveClient: async () => client as never,
      hashFile: async () => "hash-stay",
    });
    const res = await exec(ctxFor(root));
    expect(res.outcome).toBe("completed");
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const completed = emitted.find((e) => e.name === "sync-completed");
    expect(completed?.payload).toMatchObject({
      uploaded: 1,
      deleted: 1,
    });
    expect(snaps.listForDatasource("ds-1").map((s) => s.relPath)).toEqual([
      "still-here.txt",
    ]);
  });

  it("classifies (size,mtime) match as skipped without calling uploadFile or hashing", async () => {
    await seed("b.txt", "hello");
    const st = await fsp.stat(path.join(root, "b.txt"));
    const snaps = new SnapshotRepository(db);
    snaps.upsert("ds-1", {
      relPath: "b.txt",
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256: "h-b",
      remoteHandle: "r-b",
    });

    const { client, uploadFile, deleteFile } = fakeClient();
    const hashSpy = vi.fn(async () => "should-not-be-called");
    const exec = buildMirrorSyncExecutor({
      db,
      resolveClient: async () => client as never,
      hashFile: hashSpy,
    });
    const res = await exec(ctxFor(root));
    expect(res.outcome).toBe("completed");
    expect(uploadFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    expect(hashSpy).not.toHaveBeenCalled();
    const completed = emitted.find((e) => e.name === "sync-completed");
    expect(completed?.payload).toMatchObject({ skipped: 1, uploaded: 0 });
  });
});
