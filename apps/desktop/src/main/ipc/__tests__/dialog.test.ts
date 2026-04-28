// add-engine-rename-download §18.7-§18.8 — RED tests for the
// main-process handler behind `window.api.dialog.showSaveDialog`.
//
// The handler is a thin pass-through over Electron's `dialog.showSaveDialog`
// for the download orchestrator's Shift+Click and Always-ask branches
// (design.md V4 + file-explorer/spec.md "Shift+Click forces Save-as" /
// "Always-ask routing"). The renderer-supplied options object is
// forwarded verbatim; the BrowserWindow ref is attached at the
// `ipc/index.ts` registration site (mirrors `pickFilesToUpload`).

import { describe, expect, it, vi } from "vitest";

import { handleDialogShowSaveDialog } from "../dialog.js";

describe("handleDialogShowSaveDialog — proxy over dialog.showSaveDialog", () => {
  it("delegates to deps.showSaveDialog with the renderer's opts verbatim and returns the result", async () => {
    const expected = {
      canceled: false,
      filePath: "/Users/alice/Downloads/welcome.pdf",
    };
    const showSaveDialog = vi.fn().mockResolvedValue(expected);

    const opts = {
      defaultPath: "/Users/alice/Downloads/ft5/welcome.pdf",
      title: "Save file",
      buttonLabel: "Save",
    };
    const result = await handleDialogShowSaveDialog(opts, { showSaveDialog });

    expect(showSaveDialog).toHaveBeenCalledTimes(1);
    expect(showSaveDialog).toHaveBeenCalledWith(opts);
    expect(result).toEqual(expected);
  });

  it("returns { canceled: true, filePath: undefined } when the user dismisses the dialog", async () => {
    const showSaveDialog = vi.fn().mockResolvedValue({
      canceled: true,
      filePath: undefined,
    });

    const result = await handleDialogShowSaveDialog(
      { defaultPath: "/tmp/x.pdf" },
      { showSaveDialog },
    );

    expect(result).toEqual({ canceled: true, filePath: undefined });
  });

  it("normalizes a `filePath` of empty string to undefined (Electron historic quirk)", async () => {
    // Electron has historically returned filePath="" alongside canceled=true on
    // some platforms. The renderer's downstream branching is `if
    // (result.canceled || !result.filePath) return;` — keeping `filePath` as
    // undefined when the dialog was canceled keeps the renderer-side type
    // narrowing consistent.
    const showSaveDialog = vi.fn().mockResolvedValue({
      canceled: true,
      filePath: "",
    });

    const result = await handleDialogShowSaveDialog(
      { defaultPath: "/tmp/x.pdf" },
      { showSaveDialog },
    );

    expect(result.canceled).toBe(true);
    expect(result.filePath).toBeUndefined();
  });

  it("propagates dialog rejections as-is", async () => {
    const boom = new Error("dialog crashed");
    const showSaveDialog = vi.fn().mockRejectedValue(boom);

    await expect(
      handleDialogShowSaveDialog({ defaultPath: "/x" }, { showSaveDialog }),
    ).rejects.toBe(boom);
  });
});
