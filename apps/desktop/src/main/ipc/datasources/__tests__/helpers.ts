// Shared test helpers for the datasources IPC handler suite.
//
// Each test boots a fresh in-memory engine: open `:memory:` DB, run the
// default migrations, and call `initEngine(db)`. A seed helper populates
// the registry with summaries that mirror the old in-memory fixture so
// existing UI assertions (paused / connected / syncing / error variants,
// quota=true/false mix) keep covering the same ground.
//
// NOTE ON `vi.mock("electron", ...)`:
// Each test file inlines its own `electron` mock factory via
// `vi.hoisted(...)` because `vi.mock` is hoisted above all imports and so
// cannot close over a module-scoped import from this helper module. The
// XOR-based safeStorage body is identical across callers.

import type {
  DatasourceSummary,
  StoredCredentials,
} from "@ft5/ipc-contracts";

export function makeCreds(providerId: string): StoredCredentials {
  const now = 1_700_000_000_000;
  return {
    providerId,
    authResult: {
      accessToken: "mock-token",
      refreshToken: "mock-refresh",
      expiresAt: now + 3600_000,
      meta: {},
    },
    createdAt: now,
    updatedAt: now,
  };
}

export const FIXTURE_SUMMARIES: ReadonlyArray<DatasourceSummary> = [
  {
    id: "ds-gdrive-personal",
    displayName: "Personal Drive",
    providerId: "google-drive",
    status: "connected",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 1240,
    usage: { used: 12_000_000_000, quota: 16_000_000_000 },
  },
  {
    id: "ds-onedrive-work",
    displayName: "Work OneDrive",
    providerId: "onedrive",
    status: "syncing",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 4812,
    usage: { used: 880_000_000_000, quota: 1_000_000_000_000 },
  },
  {
    id: "ds-s3-archive",
    displayName: "Archive Bucket",
    providerId: "amazon-s3",
    status: "paused",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 23_401,
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
  },
];
