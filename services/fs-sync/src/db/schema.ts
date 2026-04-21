// Drizzle schema for `sync.db`. The service owns this database exclusively;
// the desktop app never opens it. All access from other processes is via
// the IPC surface.
//
// Core tables per design.md D6:
//   service_meta     schemaVersion, installedAt, serviceUuid
//   jobs             job lifecycle rows — see "Jobs table state machine"
//                    requirement
//   sync_snapshot    PK (datasourceId, relPath) — mirror-sync diff basis
//   retry_policies   PK (scope, datasourceId) — user-level retry override

import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const serviceMeta = sqliteTable("service_meta", {
  id: integer("id").primaryKey(),
  schemaVersion: integer("schema_version").notNull(),
  installedAt: integer("installed_at").notNull(),
  serviceUuid: text("service_uuid").notNull(),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["upload", "sync"] }).notNull(),
  datasourceId: text("datasource_id").notNull(),
  sourcePath: text("source_path").notNull(),
  targetPath: text("target_path"),
  conflictPolicy: text("conflict_policy", {
    enum: ["overwrite", "duplicate", "skip"],
  }).notNull(),
  status: text("status", {
    enum: [
      "queued",
      "running",
      "waiting-network",
      "completed",
      "failed",
      "cancelled",
    ],
  }).notNull(),
  attempt: integer("attempt").notNull().default(0),
  lastErrorTag: text("last_error_tag"),
  lastErrorMessage: text("last_error_message"),
  retryPolicyJson: text("retry_policy_json"),
  payloadJson: text("payload_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const syncSnapshot = sqliteTable(
  "sync_snapshot",
  {
    datasourceId: text("datasource_id").notNull(),
    relPath: text("rel_path").notNull(),
    size: integer("size").notNull(),
    mtimeMs: integer("mtime_ms").notNull(),
    sha256: text("sha256"),
    remoteHandle: text("remote_handle").notNull(),
    remoteEtag: text("remote_etag"),
    syncedAt: integer("synced_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.datasourceId, t.relPath] }),
  }),
);

export const retryPolicies = sqliteTable(
  "retry_policies",
  {
    scope: text("scope", { enum: ["global", "datasource"] }).notNull(),
    datasourceId: text("datasource_id").notNull().default(""),
    maxAttempts: integer("max_attempts").notNull(),
    backoffMs: integer("backoff_ms").notNull(),
    backoffStrategy: text("backoff_strategy", {
      enum: ["fixed", "exponential"],
    }).notNull(),
    maxAgeMs: integer("max_age_ms"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scope, t.datasourceId] }),
  }),
);
