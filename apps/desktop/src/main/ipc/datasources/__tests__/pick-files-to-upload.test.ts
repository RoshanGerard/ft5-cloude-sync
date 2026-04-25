// add-file-explorer-drag-drop-upload task 2.3 — RED test for the
// main-process native-picker handler.
//
// `handlePickFilesToUpload` opens `dialog.showOpenDialog` with
// `properties: ["openFile", "multiSelections"]` and returns the
// `{ canceled, filePaths }` tuple verbatim. It does NOT enqueue; it
// does NOT know the datasource; it does NOT mutate paths. The dialog
// call itself lives in `ipc/index.ts` (so Electron stays out of the
// handler module), and the handler receives a `showOpenDialog` stub
// via `deps` — matching the DI pattern used by the retired
// `handleDatasourcesUpload`.

import { describe, expect, it, vi } from "vitest";

import type { DatasourcesPickFilesResponse } from "@ft5/ipc-contracts";

import { handlePickFilesToUpload } from "../pick-files-to-upload.js";

describe("handlePickFilesToUpload — native picker proxy", () => {
  it("returns { canceled: true, filePaths: [] } when the user dismisses the picker", async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: true,
      filePaths: [],
    });

    const result: DatasourcesPickFilesResponse = await handlePickFilesToUpload(
      { showOpenDialog },
    );

    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ canceled: true, filePaths: [] });
  });

  it("returns { canceled: false, filePaths } verbatim when the user selects multiple files", async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ["/home/user/a.txt", "/home/user/b.txt"],
    });

    const result = await handlePickFilesToUpload({ showOpenDialog });

    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    expect(result.canceled).toBe(false);
    expect(result.filePaths).toEqual(["/home/user/a.txt", "/home/user/b.txt"]);
  });

  it("returns a defensive copy of filePaths so mutations on the OS array do not leak", async () => {
    const osArray = ["/a", "/b"];
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: osArray,
    });

    const result = await handlePickFilesToUpload({ showOpenDialog });

    // Mutating the array the OS handed us MUST NOT change the handler's
    // return value — renderers receive readonly paths and stale references
    // to the OS buffer would be a subtle cross-window bug.
    osArray.push("/c");
    expect(result.filePaths).toEqual(["/a", "/b"]);
  });

  it("propagates picker rejections as-is (Electron does not wrap its own errors)", async () => {
    const boom = new Error("picker crashed");
    const showOpenDialog = vi.fn().mockRejectedValue(boom);

    await expect(
      handlePickFilesToUpload({ showOpenDialog }),
    ).rejects.toBe(boom);
  });
});
