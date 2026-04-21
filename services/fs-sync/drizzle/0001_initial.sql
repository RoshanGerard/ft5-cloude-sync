-- Initial schema for services/fs-sync sync.db
-- Applied once per fresh DB; idempotent via `IF NOT EXISTS` guards.

CREATE TABLE IF NOT EXISTS `service_meta` (
  `id` INTEGER PRIMARY KEY,
  `schema_version` INTEGER NOT NULL,
  `installed_at` INTEGER NOT NULL,
  `service_uuid` TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS `jobs` (
  `id` TEXT PRIMARY KEY,
  `kind` TEXT NOT NULL CHECK (`kind` IN ('upload', 'sync')),
  `datasource_id` TEXT NOT NULL,
  `source_path` TEXT NOT NULL,
  `target_path` TEXT,
  `conflict_policy` TEXT NOT NULL
    CHECK (`conflict_policy` IN ('overwrite', 'duplicate', 'skip')),
  `status` TEXT NOT NULL
    CHECK (`status` IN (
      'queued', 'running', 'waiting-network', 'completed', 'failed', 'cancelled'
    )),
  `attempt` INTEGER NOT NULL DEFAULT 0,
  `last_error_tag` TEXT,
  `last_error_message` TEXT,
  `retry_policy_json` TEXT,
  `payload_json` TEXT,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS `jobs_status_idx` ON `jobs` (`status`);
CREATE INDEX IF NOT EXISTS `jobs_datasource_sourcepath_idx`
  ON `jobs` (`datasource_id`, `source_path`);

CREATE TABLE IF NOT EXISTS `sync_snapshot` (
  `datasource_id` TEXT NOT NULL,
  `rel_path` TEXT NOT NULL,
  `size` INTEGER NOT NULL,
  `mtime_ms` INTEGER NOT NULL,
  `sha256` TEXT,
  `remote_handle` TEXT NOT NULL,
  `remote_etag` TEXT,
  `synced_at` INTEGER NOT NULL,
  PRIMARY KEY (`datasource_id`, `rel_path`)
);

CREATE TABLE IF NOT EXISTS `retry_policies` (
  `scope` TEXT NOT NULL CHECK (`scope` IN ('global', 'datasource')),
  `datasource_id` TEXT NOT NULL DEFAULT '',
  `max_attempts` INTEGER NOT NULL,
  `backoff_ms` INTEGER NOT NULL,
  `backoff_strategy` TEXT NOT NULL
    CHECK (`backoff_strategy` IN ('fixed', 'exponential')),
  `max_age_ms` INTEGER,
  PRIMARY KEY (`scope`, `datasource_id`)
);
