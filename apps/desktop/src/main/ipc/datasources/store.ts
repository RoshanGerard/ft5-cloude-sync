import type { DatasourceSummary } from "@ft5/ipc-contracts";

const seedFixture = (): DatasourceSummary[] => [
  {
    id: "ds-gdrive-personal",
    displayName: "Personal Drive",
    providerId: "google-drive",
    status: "connected",
    lastSyncAt: Date.now() - 1000 * 60 * 5,
    itemCount: 1_240,
    usage: { used: 12_000_000_000, quota: 16_000_000_000 },
  },
  {
    id: "ds-onedrive-work",
    displayName: "Work OneDrive",
    providerId: "onedrive",
    status: "syncing",
    lastSyncAt: Date.now() - 1000 * 30,
    itemCount: 4_812,
    usage: { used: 880_000_000_000, quota: 1_000_000_000_000 },
  },
  {
    id: "ds-s3-archive",
    displayName: "Archive Bucket",
    providerId: "amazon-s3",
    status: "paused",
    lastSyncAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
    itemCount: 23_401,
  },
  {
    id: "ds-gdrive-team",
    displayName: "Team Shared Drive",
    providerId: "google-drive",
    status: "error",
    lastSyncAt: Date.now() - 1000 * 60 * 60 * 8,
    itemCount: 312,
    usage: { used: 5_400_000_000, quota: 16_000_000_000 },
    errorReason: "Refresh token expired — reconnect required",
  },
];

let datasources: DatasourceSummary[] = seedFixture();
let nextId = 1;

export function getDatasources(): readonly DatasourceSummary[] {
  return datasources;
}

export function addDatasource(entry: Omit<DatasourceSummary, "id">): DatasourceSummary {
  const created: DatasourceSummary = {
    ...entry,
    id: `ds-new-${String(nextId++)}`,
  };
  datasources = [...datasources, created];
  return created;
}

export function removeDatasource(datasourceId: string): boolean {
  const next = datasources.filter((ds) => ds.id !== datasourceId);
  const removed = next.length !== datasources.length;
  datasources = next;
  return removed;
}

export function updateDatasource(
  datasourceId: string,
  patch: Partial<Omit<DatasourceSummary, "id">>,
): DatasourceSummary | null {
  let updated: DatasourceSummary | null = null;
  datasources = datasources.map((ds) => {
    if (ds.id !== datasourceId) return ds;
    updated = { ...ds, ...patch };
    return updated;
  });
  return updated;
}

export function resetDatasourcesStore(): void {
  datasources = seedFixture();
  nextId = 1;
}
