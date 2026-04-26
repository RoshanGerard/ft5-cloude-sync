// Phase 9d — `handleDatasourcesRemove` deletes the datasource row via the
// DB-backed registry.
//
// As of wire-fs-sync-service section 9 the handler no longer cascades to
// a credential store (the fs-sync service owns credentials end-to-end).
//
// implement-datasource-onboarding §20 — the remove handler now ALSO
// invokes the service's `sync:delete-credentials` after `registry.remove`
// succeeds so the per-user credential entry on the service side is
// cleaned up alongside the desktop registry row. Failures of that call
// are best-effort (per design Decision 12 + Risks §1) — they MUST NOT
// block the local remove from succeeding.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FIXTURE_SUMMARIES } from "./helpers.js";

import { openDatabase, runMigrations } from "../../../db/database.js";
import { DEFAULT_MIGRATIONS } from "../../../db/migrations.js";
import {
  getEngine,
  initEngine,
  resetEngineForTests,
} from "../../../datasources/engine.js";
import type { SyncClient } from "../../../sync/client.js";
import { handleDatasourcesList } from "../list.js";
import { handleDatasourcesRemove } from "../remove.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

describe("handleDatasourcesRemove", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    resetEngineForTests();
    db = openDatabase(":memory:");
    runMigrations(db, DEFAULT_MIGRATIONS);
    initEngine(db);
    const { registry } = getEngine();
    for (const summary of FIXTURE_SUMMARIES) {
      const seed =
        summary.status === "paused"
          ? { ...summary, status: "connected" as const }
          : summary;
      registry.add(seed);
      if (summary.status === "paused") {
        registry.setPaused(summary.id, true);
      }
    }
  });

  afterEach(() => {
    resetEngineForTests();
    db.close();
  });

  // Minimal SyncClient stub — only `deleteCredentials` is exercised here.
  // Cast via `unknown` so the partial shape type-checks without pretending
  // to implement the full interface.
  function makeStubClient(
    deleteCredentials: ReturnType<typeof vi.fn>,
  ): SyncClient {
    return { deleteCredentials } as unknown as SyncClient;
  }

  it("removes an existing datasource and returns { ok: true }", async () => {
    const target = handleDatasourcesList().datasources[0]!;
    const client = makeStubClient(
      vi.fn(async () => ({ deleted: true })),
    );
    const response = await handleDatasourcesRemove(
      { datasourceId: target.id },
      client,
    );
    expect(response).toEqual({ ok: true });
    const remaining = handleDatasourcesList().datasources;
    expect(remaining.some((ds) => ds.id === target.id)).toBe(false);
  });

  it("invokes registry.remove with the target id", async () => {
    const { registry } = getEngine();
    const spy = vi.spyOn(registry, "remove");
    const target = handleDatasourcesList().datasources[0]!;
    const client = makeStubClient(
      vi.fn(async () => ({ deleted: true })),
    );
    await handleDatasourcesRemove({ datasourceId: target.id }, client);
    expect(spy).toHaveBeenCalledWith(target.id);
  });

  it("throws for an unknown datasourceId rather than silently no-op-ing", async () => {
    const client = makeStubClient(
      vi.fn(async () => ({ deleted: true })),
    );
    await expect(
      handleDatasourcesRemove(
        { datasourceId: "ds-does-not-exist" },
        client,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("does not touch the factory (remove is pure-DB)", async () => {
    const { factory } = getEngine();
    const factorySpy = vi.spyOn(factory, "create");
    const target = handleDatasourcesList().datasources[0]!;
    const client = makeStubClient(
      vi.fn(async () => ({ deleted: true })),
    );
    await handleDatasourcesRemove({ datasourceId: target.id }, client);
    expect(factorySpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // §20 — sync:delete-credentials cleanup
  // -----------------------------------------------------------------------

  it("calls syncClient.deleteCredentials({datasourceId}) exactly once after registry.remove succeeds", async () => {
    const target = handleDatasourcesList().datasources[0]!;
    const deleteCredentials = vi.fn(async () => ({ deleted: true }));
    const client = makeStubClient(deleteCredentials);

    await handleDatasourcesRemove({ datasourceId: target.id }, client);

    expect(deleteCredentials).toHaveBeenCalledTimes(1);
    expect(deleteCredentials).toHaveBeenCalledWith({
      datasourceId: target.id,
    });
  });

  it("calls deleteCredentials AFTER registry.remove (not before)", async () => {
    const { registry } = getEngine();
    const calls: string[] = [];
    const removeSpy = vi
      .spyOn(registry, "remove")
      .mockImplementation((id: string) => {
        calls.push(`registry.remove(${id})`);
        // Delegate to the real impl via the spy-restored prototype.
        // We can't easily call the original here without restoring; use a
        // direct DB delete to mirror behaviour.
        const info = (
          registry as unknown as {
            removeRowStmt: { run: (id: string) => { changes: number } };
          }
        ).removeRowStmt.run(id);
        return info.changes > 0;
      });
    const deleteCredentials = vi.fn(async (params: { datasourceId: string }) => {
      calls.push(`deleteCredentials(${params.datasourceId})`);
      return { deleted: true };
    });
    const client = makeStubClient(deleteCredentials);
    const target = handleDatasourcesList().datasources[0]!;

    await handleDatasourcesRemove({ datasourceId: target.id }, client);

    expect(calls).toEqual([
      `registry.remove(${target.id})`,
      `deleteCredentials(${target.id})`,
    ]);
    removeSpy.mockRestore();
  });

  it("logs a structured warning and resolves successfully when deleteCredentials rejects (best-effort cleanup)", async () => {
    const target = handleDatasourcesList().datasources[0]!;
    const deleteCredentials = vi.fn(async () => {
      throw new Error("service unavailable");
    });
    const client = makeStubClient(deleteCredentials);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      handleDatasourcesRemove({ datasourceId: target.id }, client),
    ).resolves.toEqual({ ok: true });

    // The local row was still removed (best-effort cleanup MUST NOT block
    // the user-facing remove).
    const remaining = handleDatasourcesList().datasources;
    expect(remaining.some((ds) => ds.id === target.id)).toBe(false);

    // A structured warning was emitted.
    expect(warnSpy).toHaveBeenCalled();
    const warningCall = warnSpy.mock.calls.find((args) =>
      String(args[0]).includes("delete-credentials"),
    );
    expect(warningCall).toBeDefined();
    warnSpy.mockRestore();
  });

  it("does NOT call deleteCredentials when the local registry remove fails", async () => {
    const deleteCredentials = vi.fn(async () => ({ deleted: true }));
    const client = makeStubClient(deleteCredentials);

    await expect(
      handleDatasourcesRemove({ datasourceId: "ds-missing" }, client),
    ).rejects.toThrow(/not found/i);

    expect(deleteCredentials).not.toHaveBeenCalled();
  });
});
