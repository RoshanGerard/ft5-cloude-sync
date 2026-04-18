import { describe, expect, it } from "vitest";

import { handleDatasourcesList } from "../list";
import { handleDatasourcesRemove } from "../remove";
import { resetDatasourcesStore } from "../store";

describe("handleDatasourcesRemove", () => {
  it("removes an existing datasource and returns { ok: true }", () => {
    resetDatasourcesStore();
    const target = handleDatasourcesList().datasources[0]!;
    const response = handleDatasourcesRemove({ datasourceId: target.id });
    expect(response).toEqual({ ok: true });
    const remaining = handleDatasourcesList().datasources;
    expect(remaining.some((ds) => ds.id === target.id)).toBe(false);
  });

  it("throws for an unknown datasourceId rather than silently no-op-ing", () => {
    resetDatasourcesStore();
    expect(() =>
      handleDatasourcesRemove({ datasourceId: "ds-does-not-exist" }),
    ).toThrow(/not found/i);
  });
});
