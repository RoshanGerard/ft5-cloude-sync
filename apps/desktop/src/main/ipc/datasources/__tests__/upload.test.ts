import { describe, expect, it, vi } from "vitest";

import type { DatasourcesUploadProgressEvent } from "@ft5/ipc-contracts";

import { handleDatasourcesUpload, type UploadDeps } from "../upload";
import { resetDatasourcesStore } from "../store";

function makeDeps(overrides: Partial<UploadDeps> = {}): UploadDeps {
  return {
    showOpenDialog: vi
      .fn()
      .mockResolvedValue({
        canceled: false,
        filePaths: ["C:/mock/file-a.txt", "C:/mock/file-b.txt"],
      }),
    sendProgress: vi.fn(),
    nextTransactionId: vi.fn().mockReturnValue("tx-test-1"),
    ...overrides,
  };
}

describe("handleDatasourcesUpload", () => {
  it("opens the main-process dialog and returns a transactionId", async () => {
    resetDatasourcesStore();
    const deps = makeDeps();
    const response = await handleDatasourcesUpload(
      { datasourceId: "ds-gdrive-personal" },
      deps,
    );
    expect(deps.showOpenDialog).toHaveBeenCalledOnce();
    expect(response.transactionId).toBe("tx-test-1");
  });

  it("emits progress events scoped to the returned transactionId", async () => {
    resetDatasourcesStore();
    const deps = makeDeps();
    await handleDatasourcesUpload(
      { datasourceId: "ds-gdrive-personal" },
      deps,
    );
    const sendProgress = deps.sendProgress as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(sendProgress).toHaveBeenCalled();
    const emittedEvents: DatasourcesUploadProgressEvent[] = sendProgress.mock
      .calls.map((call: unknown[]) => call[0] as DatasourcesUploadProgressEvent);
    for (const ev of emittedEvents) {
      expect(ev.transactionId).toBe("tx-test-1");
    }
    const statuses = emittedEvents.map((ev) => ev.status);
    expect(statuses).toContain("uploading");
    expect(statuses[statuses.length - 1]).toBe("completed");
  });

  it("throws when the user cancels the file picker", async () => {
    resetDatasourcesStore();
    const deps = makeDeps({
      showOpenDialog: vi
        .fn()
        .mockResolvedValue({ canceled: true, filePaths: [] }),
    });
    await expect(
      handleDatasourcesUpload({ datasourceId: "ds-gdrive-personal" }, deps),
    ).rejects.toThrow(/cancell?ed/i);
    expect(deps.sendProgress).not.toHaveBeenCalled();
  });

  it("throws when the datasource does not exist", async () => {
    resetDatasourcesStore();
    const deps = makeDeps();
    await expect(
      handleDatasourcesUpload({ datasourceId: "ds-nope" }, deps),
    ).rejects.toThrow(/not found/i);
    expect(deps.showOpenDialog).not.toHaveBeenCalled();
  });
});
