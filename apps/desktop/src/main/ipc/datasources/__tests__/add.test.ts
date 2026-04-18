import { describe, expect, it } from "vitest";

import { handleDatasourcesAdd } from "../add";
import { handleDatasourcesList } from "../list";
import { resetDatasourcesStore } from "../store";

describe("handleDatasourcesAdd", () => {
  it("creates a connected datasource for google-drive and returns it", () => {
    resetDatasourcesStore();
    const response = handleDatasourcesAdd({
      providerId: "google-drive",
      credentials: { accessToken: "mock-token" },
    });
    expect(response.datasource.id).toMatch(/^ds-new-/);
    expect(response.datasource.providerId).toBe("google-drive");
    expect(response.datasource.status).toBe("connected");
    expect(response.datasource.lastSyncAt).toBeNull();
    expect(response.datasource.itemCount).toBe(0);
    expect(response.datasource.usage).toBeDefined();
    expect(response.datasource.usage!.used).toBe(0);
  });

  it("creates an amazon-s3 datasource WITHOUT usage (quota=false provider)", () => {
    resetDatasourcesStore();
    const response = handleDatasourcesAdd({
      providerId: "amazon-s3",
      credentials: { accessKeyId: "K", secretAccessKey: "S", bucket: "b" },
    });
    expect(response.datasource.providerId).toBe("amazon-s3");
    expect(response.datasource.usage).toBeUndefined();
  });

  it("appends the new datasource so list() returns it", () => {
    resetDatasourcesStore();
    const before = handleDatasourcesList().datasources.length;
    const { datasource } = handleDatasourcesAdd({
      providerId: "onedrive",
      credentials: { accessToken: "t" },
    });
    const after = handleDatasourcesList().datasources;
    expect(after.length).toBe(before + 1);
    expect(after.some((ds) => ds.id === datasource.id)).toBe(true);
  });

  it("throws for an unknown providerId", () => {
    resetDatasourcesStore();
    expect(() =>
      handleDatasourcesAdd({
        providerId: "dropbox",
        credentials: {},
      }),
    ).toThrow(/unknown provider/i);
  });
});
