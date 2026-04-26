// implement-datasource-onboarding §17 — `DatasourceRegistry.add` is
// idempotent on the primary key.
//
// Spec refs:
//   - openspec/changes/implement-datasource-onboarding/design.md
//     Decision 8 ("idempotent registry.add triggered by credential-persisted
//     event"): "registry.add becomes idempotent via INSERT ... ON CONFLICT(id)
//     DO UPDATE SET ...". Existing add callers expect insertion semantics; the
//     new idempotency does not break them — duplicate-id callers today already
//     see a SQLite UNIQUE constraint exception.
//
// Why a separate test file from the existing `registry.test.ts`:
//   - Keeps the §17 deliverable observable as one TDD pass.
//   - The existing file's "first-insert semantics" tests stay as-is to back
//     the §17.3 "no regression on first-insert" check.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, runMigrations } from "../db/database.js";
import { DEFAULT_MIGRATIONS } from "../db/migrations.js";
import { DatasourceRegistry } from "./registry.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

describe("DatasourceRegistry — idempotent add (§17)", () => {
  let db: SqliteDatabase;
  let registry: DatasourceRegistry;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db, DEFAULT_MIGRATIONS);
    registry = new DatasourceRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  it("calling add() twice with the same id does NOT throw", () => {
    const summary = {
      id: "ds-1",
      displayName: "My Drive",
      providerId: "google-drive",
      status: "connected" as const,
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    };
    registry.add(summary);
    expect(() => registry.add(summary)).not.toThrow();

    // The list should still contain a single row for that id.
    const rows = registry.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("ds-1");
  });

  it("second add() updates display_name / status / error_reason / error_kind when they differ", () => {
    registry.add({
      id: "ds-1",
      displayName: "Original Name",
      providerId: "google-drive",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });

    // Re-add with a different displayName and an error state. The
    // idempotent path SHALL surface the new column values verbatim.
    registry.add({
      id: "ds-1",
      displayName: "Renamed Drive",
      providerId: "google-drive",
      status: "error",
      lastSyncAt: null,
      itemCount: 0,
      errorReason: "auth revoked",
      errorKind: "auth-revoked",
    });

    const [row] = registry.list();
    expect(row!.displayName).toBe("Renamed Drive");
    expect(row!.status).toBe("error");
    expect(row!.errorReason).toBe("auth revoked");
    expect(row!.errorKind).toBe("auth-revoked");
  });

  it("created_at is preserved across re-add; only updated_at advances", async () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "amazon-s3",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });

    const initial = db
      .prepare(
        "SELECT created_at, updated_at FROM datasources WHERE id = ?",
      )
      .get("ds-1") as { created_at: number; updated_at: number };

    // Wait a few milliseconds so Date.now() advances past the initial stamp.
    // The first add stamps both columns; the re-add must leave created_at
    // intact and bump updated_at to a strictly-later value.
    await new Promise<void>((r) => setTimeout(r, 5));

    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "amazon-s3",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });

    const after = db
      .prepare(
        "SELECT created_at, updated_at FROM datasources WHERE id = ?",
      )
      .get("ds-1") as { created_at: number; updated_at: number };

    expect(after.created_at).toBe(initial.created_at);
    expect(after.updated_at).toBeGreaterThan(initial.updated_at);
  });
});
