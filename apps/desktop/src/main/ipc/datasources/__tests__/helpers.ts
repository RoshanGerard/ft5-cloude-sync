// Shared test helpers for the datasources IPC handler suite.
//
// Each test boots a fresh in-memory engine: open `:memory:` DB, run the
// default migrations, and call `initEngine(db)`. A seed helper populates
// the registry with summaries that mirror the old in-memory fixture so
// existing UI assertions (paused / connected / syncing / error variants,
// quota=true/false mix) keep covering the same ground.
//
// NOTE: credentials are no longer the desktop's concern as of
// wire-fs-sync-service section 9 — the fs-sync service owns them.
// Consequently this helper module ships only `FIXTURE_SUMMARIES`; the
// former `makeCreds()` helper and the electron mock are gone.

import type { DatasourceSummary } from "@ft5/ipc-contracts";

export const FIXTURE_SUMMARIES: ReadonlyArray<DatasourceSummary> = [
  {
    id: "ds-gdrive-personal",
    displayName: "Personal Drive",
    providerId: "google-drive",
    status: "connected",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 1240,
    usage: { used: 12_000_000_000, quota: 16_000_000_000 },
    errorKind: null,
  },
  {
    id: "ds-onedrive-work",
    displayName: "Work OneDrive",
    providerId: "onedrive",
    status: "syncing",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 4812,
    usage: { used: 880_000_000_000, quota: 1_000_000_000_000 },
    errorKind: null,
  },
  {
    id: "ds-s3-archive",
    displayName: "Archive Bucket",
    providerId: "amazon-s3",
    status: "paused",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 23_401,
    errorKind: null,
  },
  {
    id: "ds-gdrive-team",
    displayName: "Team Shared Drive",
    providerId: "google-drive",
    status: "error",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 312,
    usage: { used: 5_400_000_000, quota: 16_000_000_000 },
    errorReason: "Refresh token expired — reconnect required",
    errorKind: "auth-revoked",
  },
];
