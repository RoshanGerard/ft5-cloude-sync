// add-engine-rename-download §18.3-§18.6 — RED tests for the main-process
// handlers behind `window.api.files.openSavedPath` and
// `window.api.files.showSavedInFolder`.
//
// The handlers are thin proxies over Electron's `shell.openPath` /
// `shell.showItemInFolder`. The Electron `shell` import lives in
// `ipc/index.ts` (so the handler module stays free of Electron and unit
// tests run under plain Node); each handler receives its shell binding
// via `deps`. Same DI pattern as `handlePickFilesToUpload`.

import { describe, expect, it, vi } from "vitest";

import {
  handleFilesOpenSavedPath,
  handleFilesShowSavedInFolder,
} from "../open-saved.js";

describe("handleFilesOpenSavedPath — proxy over shell.openPath", () => {
  it("delegates to deps.openPath with the savedPath verbatim", async () => {
    const openPath = vi.fn().mockResolvedValue("");

    await handleFilesOpenSavedPath("/Users/alice/Downloads/ft5/welcome.pdf", {
      openPath,
    });

    expect(openPath).toHaveBeenCalledTimes(1);
    expect(openPath).toHaveBeenCalledWith(
      "/Users/alice/Downloads/ft5/welcome.pdf",
    );
  });

  it("resolves void even when shell.openPath returns a non-empty error string", async () => {
    // Electron's `shell.openPath` resolves with a string: empty on success,
    // non-empty when the OS rejected the open request (file not found,
    // unsupported file type without an associated handler, etc.). The
    // handler intentionally swallows the string — the renderer's toast has
    // already dismissed and there's no return surface; logging is enough.
    // (See ESLint rule no-unused-vars for the choice not to forward.)
    const openPath = vi.fn().mockResolvedValue("file not found");
    const result = await handleFilesOpenSavedPath("/missing.pdf", { openPath });
    expect(result).toBeUndefined();
    expect(openPath).toHaveBeenCalledWith("/missing.pdf");
  });
});

describe("handleFilesShowSavedInFolder — proxy over shell.showItemInFolder", () => {
  it("delegates to deps.showItemInFolder with the savedPath verbatim", () => {
    const showItemInFolder = vi.fn();

    handleFilesShowSavedInFolder("/Users/alice/Downloads/ft5/welcome.pdf", {
      showItemInFolder,
    });

    expect(showItemInFolder).toHaveBeenCalledTimes(1);
    expect(showItemInFolder).toHaveBeenCalledWith(
      "/Users/alice/Downloads/ft5/welcome.pdf",
    );
  });

  it("returns void synchronously (Electron's showItemInFolder is sync)", () => {
    const showItemInFolder = vi.fn();
    const result = handleFilesShowSavedInFolder("/any/path", {
      showItemInFolder,
    });
    expect(result).toBeUndefined();
  });
});
