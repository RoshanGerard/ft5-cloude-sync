import { describe, expect, it } from "vitest";

import { providers } from "@ft5/ipc-contracts";
import type { DatasourceStatus, DatasourceSummary } from "@ft5/ipc-contracts";

import { handleDatasourcesList } from "../list";
import { resetDatasourcesStore } from "../store";

describe("handleDatasourcesList", () => {
  it("returns a structured-clone-safe { datasources: DatasourceSummary[] }", () => {
    resetDatasourcesStore();
    const response = handleDatasourcesList();
    expect(response).toHaveProperty("datasources");
    expect(Array.isArray(response.datasources)).toBe(true);
    for (const ds of response.datasources) {
      expect(typeof ds.id).toBe("string");
      expect(typeof ds.displayName).toBe("string");
      expect(typeof ds.providerId).toBe("string");
      expect(["connected", "syncing", "paused", "error"]).toContain(ds.status);
      expect(ds.lastSyncAt === null || typeof ds.lastSyncAt === "number").toBe(
        true,
      );
      expect(typeof ds.itemCount).toBe("number");
      if (ds.usage !== undefined) {
        expect(typeof ds.usage.used).toBe("number");
        expect(typeof ds.usage.quota).toBe("number");
      }
      if (ds.errorReason !== undefined) {
        expect(typeof ds.errorReason).toBe("string");
      }
    }
  });

  it("fixture includes at least one datasource of each status variant", () => {
    resetDatasourcesStore();
    const { datasources } = handleDatasourcesList();
    const statusesPresent = new Set<DatasourceStatus>(
      datasources.map((ds) => ds.status),
    );
    expect(statusesPresent.has("connected")).toBe(true);
    expect(statusesPresent.has("syncing")).toBe(true);
    expect(statusesPresent.has("paused")).toBe(true);
    expect(statusesPresent.has("error")).toBe(true);
  });

  it("fixture includes a quota=false provider (S3) alongside quota=true providers", () => {
    resetDatasourcesStore();
    const { datasources } = handleDatasourcesList();
    const withQuotaTrue = datasources.filter((ds) => {
      const descriptor = providers[ds.providerId as keyof typeof providers];
      return descriptor?.capabilities.quota === true;
    });
    const withQuotaFalse = datasources.filter((ds) => {
      const descriptor = providers[ds.providerId as keyof typeof providers];
      return descriptor?.capabilities.quota === false;
    });
    expect(withQuotaTrue.length).toBeGreaterThanOrEqual(1);
    expect(withQuotaFalse.length).toBeGreaterThanOrEqual(1);
  });

  it("datasources with error status include an errorReason string", () => {
    resetDatasourcesStore();
    const { datasources } = handleDatasourcesList();
    const errorOnes = datasources.filter(
      (ds: DatasourceSummary) => ds.status === "error",
    );
    for (const ds of errorOnes) {
      expect(typeof ds.errorReason).toBe("string");
      expect(ds.errorReason!.length).toBeGreaterThan(0);
    }
  });
});
