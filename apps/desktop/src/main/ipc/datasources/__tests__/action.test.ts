import { describe, expect, it } from "vitest";

import { handleDatasourcesAction } from "../action";
import { handleDatasourcesList } from "../list";
import { resetDatasourcesStore } from "../store";

function findByStatus(status: string) {
  return handleDatasourcesList().datasources.find((ds) => ds.status === status);
}

describe("handleDatasourcesAction", () => {
  it("pause: sets status to paused", () => {
    resetDatasourcesStore();
    const target = findByStatus("connected")!;
    const { datasource } = handleDatasourcesAction({
      datasourceId: target.id,
      action: "pause",
    });
    expect(datasource.status).toBe("paused");
    expect(datasource.id).toBe(target.id);
  });

  it("resume: sets status to connected", () => {
    resetDatasourcesStore();
    const target = findByStatus("paused")!;
    const { datasource } = handleDatasourcesAction({
      datasourceId: target.id,
      action: "resume",
    });
    expect(datasource.status).toBe("connected");
  });

  it("sync-now: sets status to syncing and updates lastSyncAt forward", () => {
    resetDatasourcesStore();
    const target = findByStatus("connected")!;
    const before = Date.now();
    const { datasource } = handleDatasourcesAction({
      datasourceId: target.id,
      action: "sync-now",
    });
    expect(datasource.status).toBe("syncing");
    expect(datasource.lastSyncAt).not.toBeNull();
    expect(datasource.lastSyncAt!).toBeGreaterThanOrEqual(before - 100);
  });

  it("throws for an unknown datasourceId", () => {
    resetDatasourcesStore();
    expect(() =>
      handleDatasourcesAction({
        datasourceId: "ds-does-not-exist",
        action: "pause",
      }),
    ).toThrow(/not found/i);
  });
});
