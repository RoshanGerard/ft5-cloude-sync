// Phase 9b — DB-backed DatasourceRegistry.
//
// Replaces the in-memory fixture at
// `apps/desktop/src/main/ipc/datasources/store.ts`. Management IPC handlers
// (add / list / remove / action) delegate to this class. `list()` maps DB
// rows to the shared `DatasourceSummary` contract (sets `status="paused"`
// when the `paused` column is 1, overriding the underlying status column so
// the UI sees the effective state).
//
// As of wire-fs-sync-service section 9 the registry no longer writes
// credentials — the fs-sync service owns them end-to-end. `add(summary)`
// is a single-store row insert and `remove(id)` is a single-store row
// delete. No electron mock is required.
//
// Design refs:
//   - openspec/changes/add-fs-datasource-engine/design.md Phase 9 scoping.
//   - openspec/changes/add-fs-datasource-engine/tasks.md 9.6-9.8.
//   - openspec/changes/wire-fs-sync-service/tasks.md 9.1-9.5.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, runMigrations } from "../db/database.js";
import { DEFAULT_MIGRATIONS } from "../db/migrations.js";
import { DatasourceRegistry } from "./registry.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

describe("DatasourceRegistry (Phase 9b)", () => {
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

  it("list() returns [] on an empty DB", () => {
    expect(registry.list()).toEqual([]);
  });

  it("add() inserts a row and returns the stored summary", () => {
    const summary = registry.add({
      id: "ds-1",
      displayName: "My Bucket",
      providerId: "amazon-s3",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });
    expect(summary.id).toBe("ds-1");
    expect(summary.providerId).toBe("amazon-s3");
    expect(summary.status).toBe("connected");

    const listed = registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe("ds-1");
  });

  it("add() stamps created_at and updated_at to Date.now()", () => {
    const before = Date.now();
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "amazon-s3",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });
    const after = Date.now();
    const row = db
      .prepare(
        "SELECT created_at, updated_at FROM datasources WHERE id = ?",
      )
      .get("ds-1") as { created_at: number; updated_at: number };
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.created_at).toBeLessThanOrEqual(after);
    expect(row.updated_at).toBeGreaterThanOrEqual(before);
    expect(row.updated_at).toBeLessThanOrEqual(after);
  });

  it("remove() deletes the row and returns true", () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "amazon-s3",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });
    const removed = registry.remove("ds-1");
    expect(removed).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  it("remove() returns false for an unknown id", () => {
    expect(registry.remove("nope")).toBe(false);
  });

  it("setPaused(true) makes list() report status='paused' without mutating the underlying status column", () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "onedrive",
      status: "connected",
      lastSyncAt: null,
      itemCount: 5,
      errorKind: null,
    });
    registry.setPaused("ds-1", true);

    // List() projects status='paused' when paused=1.
    const summary = registry.list()[0]!;
    expect(summary.status).toBe("paused");

    // But the status column retains its pre-pause value.
    const row = db
      .prepare("SELECT status, paused FROM datasources WHERE id = ?")
      .get("ds-1") as { status: string; paused: number };
    expect(row.status).toBe("connected");
    expect(row.paused).toBe(1);
  });

  it("setPaused(false) flips the flag back and list() reflects the underlying status again", () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "onedrive",
      status: "syncing",
      lastSyncAt: null,
      itemCount: 5,
      errorKind: null,
    });
    registry.setPaused("ds-1", true);
    registry.setPaused("ds-1", false);

    const summary = registry.list()[0]!;
    expect(summary.status).toBe("syncing");
  });

  it("setStatus() updates status + errorReason without touching paused", () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "google-drive",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });
    registry.setPaused("ds-1", true);
    registry.setStatus("ds-1", "error", "auth token expired");

    const row = db
      .prepare(
        "SELECT status, error_reason, paused FROM datasources WHERE id = ?",
      )
      .get("ds-1") as {
      status: string;
      error_reason: string;
      paused: number;
    };
    expect(row.status).toBe("error");
    expect(row.error_reason).toBe("auth token expired");
    expect(row.paused).toBe(1); // untouched
  });

  it("setStatus() clears error_reason when omitted or null", () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "google-drive",
      status: "error",
      lastSyncAt: null,
      itemCount: 0,
      errorReason: "boom",
      errorKind: null,
    });
    registry.setStatus("ds-1", "connected");
    const row = db
      .prepare("SELECT error_reason FROM datasources WHERE id = ?")
      .get("ds-1") as { error_reason: string | null };
    expect(row.error_reason).toBeNull();
  });

  it("touchLastSyncAt() bumps last_sync_at to Date.now()", () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "amazon-s3",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });
    const before = Date.now();
    registry.touchLastSyncAt("ds-1");
    const after = Date.now();
    const summary = registry.list()[0]!;
    expect(summary.lastSyncAt).not.toBeNull();
    expect(summary.lastSyncAt!).toBeGreaterThanOrEqual(before);
    expect(summary.lastSyncAt!).toBeLessThanOrEqual(after);
  });

  it("getProviderId() returns the provider id for a known datasource or null", () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "onedrive",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });
    expect(registry.getProviderId("ds-1")).toBe("onedrive");
    expect(registry.getProviderId("unknown")).toBeNull();
  });

  it("list() maps error_reason to errorReason and preserves item_count / last_sync_at", () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "google-drive",
      status: "error",
      lastSyncAt: 1_700_000_000_000,
      itemCount: 42,
      errorReason: "network down",
      errorKind: null,
    });
    const [summary] = registry.list();
    expect(summary!.errorReason).toBe("network down");
    expect(summary!.itemCount).toBe(42);
    expect(summary!.lastSyncAt).toBe(1_700_000_000_000);
  });

  it("setStatus() with errorKind persists the tag and list() returns it", () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "google-drive",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });
    registry.setStatus("ds-1", "error", "auth token revoked", "auth-revoked");

    const [summary] = registry.list();
    expect(summary!.status).toBe("error");
    expect(summary!.errorKind).toBe("auth-revoked");
  });

  it("setStatus() clears errorKind when status transitions to non-error", () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "google-drive",
      status: "error",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });
    registry.setStatus("ds-1", "error", "revoked", "auth-revoked");
    registry.setStatus("ds-1", "connected"); // clears error fields

    const [summary] = registry.list();
    expect(summary!.errorKind).toBeNull();
  });

  it("list() returns errorKind: null for non-error rows", () => {
    registry.add({
      id: "ds-1",
      displayName: "X",
      providerId: "amazon-s3",
      status: "connected",
      lastSyncAt: null,
      itemCount: 0,
      errorKind: null,
    });
    const [summary] = registry.list();
    expect(summary!.errorKind).toBeNull();
  });
});
