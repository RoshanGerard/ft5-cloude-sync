/** @vitest-environment jsdom */
//
// add-engine-rename-download §23.1 + §23.3 — RED tests for the renderer
// download orchestrator (`useDownloadOrchestrator`). Implementation lands
// in §23.2 + §23.4.
//
// Per design.md Decision 8, the orchestrator is purely the dispatcher
// (toPath resolution + save-dialog flow + first-run-modal queueing); it
// returns the `FilesDownloadResponse` envelope on dispatch (NOT a
// `downloadJobId`, since the contract carries only `{ savedPath, bytes }`).
// Toast lifecycle is owned by the §24 helper.
//
// Test scenarios:
//   §23.1 — toPath resolution rules
//     (a) default folder + no Shift + Always-ask off →
//         `<defaultFolder>/<fileName>` directly
//     (b) Shift+Click → opens `showSaveDialog` with
//         `{ defaultPath: <defaultFolder>/<fileName> }`; on cancel no IPC
//         dispatch; on pick the dispatch uses the picked path
//     (c) Always-ask preference set → same showSaveDialog flow
//     (d) successful dispatch resolves with the IPC envelope
//
//   §23.3 — first-run-modal queueing
//     (e) `getDefaultFolder()` null on first call → does NOT dispatch;
//         opens the modal (modalOpen flips true)
//     (f) modal `onCommit(folder)` → dispatch fires with the now-set
//         folder; pendingDownload is cleared

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import type {
  FileEntry,
  FilesDownloadResponse,
} from "@ft5/ipc-contracts";

import {
  DOWNLOADS_ALWAYS_ASK_KEY,
  DOWNLOADS_DEFAULT_FOLDER_KEY,
} from "../../settings/downloads-store.js";

// Subject under test (NOT YET IMPLEMENTED — these imports drive the RED).
import {
  useDownloadOrchestrator,
  type DownloadOrchestratorApi,
} from "../use-download-orchestrator.js";

// --- Helpers ---------------------------------------------------------

function makeFileEntry(name: string, parentPath: string = "/"): FileEntry {
  const path =
    parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
  return {
    id: `entry-${name}`,
    kind: "file",
    name,
    path,
    parentPath,
    size: 1024,
    mimeFamily: "document",
    mimeType: "application/pdf",
    modifiedAt: "2026-04-28T00:00:00.000Z",
    createdAt: null,
    providerMetadata: {},
  };
}

interface MockApi extends DownloadOrchestratorApi {
  download: Mock;
  showSaveDialog: Mock;
}

function makeApi(opts?: {
  downloadResult?: FilesDownloadResponse;
  saveDialogResult?: { canceled: boolean; filePath?: string };
}): MockApi {
  const download = vi.fn(async () => {
    return (
      opts?.downloadResult ?? {
        ok: true,
        value: {
          savedPath: "/Users/alice/Downloads/ft5/welcome.pdf",
          bytes: 1024,
        },
      }
    );
  });
  const showSaveDialog = vi.fn(async () => {
    return (
      opts?.saveDialogResult ?? {
        canceled: false,
        filePath: "/tmp/picked.pdf",
      }
    );
  });
  return { download, showSaveDialog };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

// --- Tests -----------------------------------------------------------

describe("useDownloadOrchestrator — toPath resolution (§23.1)", () => {
  it("(a) default-folder click computes <defaultFolder>/<fileName> directly without showSaveDialog", async () => {
    localStorage.setItem(
      DOWNLOADS_DEFAULT_FOLDER_KEY,
      "/Users/alice/Downloads/ft5",
    );
    const api = makeApi();
    const { result } = renderHook(() => useDownloadOrchestrator({ api }));

    let response: FilesDownloadResponse | null = null;
    await act(async () => {
      response = await result.current.dispatchDownload(
        makeFileEntry("welcome.pdf"),
        { shiftKey: false },
        "ds-1",
      );
    });

    expect(api.showSaveDialog).not.toHaveBeenCalled();
    expect(api.download).toHaveBeenCalledTimes(1);
    expect(api.download).toHaveBeenCalledWith({
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "/Users/alice/Downloads/ft5/welcome.pdf",
    });
    expect(response).toEqual({
      ok: true,
      value: {
        savedPath: "/Users/alice/Downloads/ft5/welcome.pdf",
        bytes: 1024,
      },
    });
  });

  it("(b1) Shift+Click opens showSaveDialog with { defaultPath: <defaultFolder>/<fileName> }; user pick drives dispatch", async () => {
    localStorage.setItem(
      DOWNLOADS_DEFAULT_FOLDER_KEY,
      "/Users/alice/Downloads/ft5",
    );
    const api = makeApi({
      saveDialogResult: { canceled: false, filePath: "/tmp/welcome.pdf" },
    });
    const { result } = renderHook(() => useDownloadOrchestrator({ api }));

    await act(async () => {
      await result.current.dispatchDownload(
        makeFileEntry("welcome.pdf"),
        { shiftKey: true },
        "ds-1",
      );
    });

    expect(api.showSaveDialog).toHaveBeenCalledTimes(1);
    const saveCall = api.showSaveDialog.mock.calls[0]?.[0] as {
      defaultPath?: string;
    };
    expect(saveCall.defaultPath).toBe("/Users/alice/Downloads/ft5/welcome.pdf");
    expect(api.download).toHaveBeenCalledTimes(1);
    expect(api.download).toHaveBeenCalledWith({
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "/tmp/welcome.pdf",
    });
  });

  it("(b2) Shift+Click with user-cancel from showSaveDialog → NO IPC dispatch", async () => {
    localStorage.setItem(
      DOWNLOADS_DEFAULT_FOLDER_KEY,
      "/Users/alice/Downloads/ft5",
    );
    const api = makeApi({
      saveDialogResult: { canceled: true },
    });
    const { result } = renderHook(() => useDownloadOrchestrator({ api }));

    let response: FilesDownloadResponse | null = null;
    await act(async () => {
      response = await result.current.dispatchDownload(
        makeFileEntry("welcome.pdf"),
        { shiftKey: true },
        "ds-1",
      );
    });

    expect(api.showSaveDialog).toHaveBeenCalledTimes(1);
    expect(api.download).not.toHaveBeenCalled();
    expect(response).toBeNull();
  });

  it("(c) Always-ask preference (alwaysAsk='yes') opens showSaveDialog even without Shift", async () => {
    localStorage.setItem(
      DOWNLOADS_DEFAULT_FOLDER_KEY,
      "/Users/alice/Downloads/ft5",
    );
    localStorage.setItem(DOWNLOADS_ALWAYS_ASK_KEY, "yes");
    const api = makeApi({
      saveDialogResult: { canceled: false, filePath: "/tmp/picked.pdf" },
    });
    const { result } = renderHook(() => useDownloadOrchestrator({ api }));

    await act(async () => {
      await result.current.dispatchDownload(
        makeFileEntry("welcome.pdf"),
        { shiftKey: false },
        "ds-1",
      );
    });

    expect(api.showSaveDialog).toHaveBeenCalledTimes(1);
    const saveCall = api.showSaveDialog.mock.calls[0]?.[0] as {
      defaultPath?: string;
    };
    expect(saveCall.defaultPath).toBe("/Users/alice/Downloads/ft5/welcome.pdf");
    expect(api.download).toHaveBeenCalledWith({
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "/tmp/picked.pdf",
    });
  });
});

describe("useDownloadOrchestrator — first-run modal queueing (§23.3)", () => {
  it("(e) when getDefaultFolder() === null, opens the modal and does NOT dispatch", async () => {
    // No localStorage value → null default folder.
    const api = makeApi();
    const { result } = renderHook(() => useDownloadOrchestrator({ api }));

    expect(result.current.modalOpen).toBe(false);

    await act(async () => {
      // The dispatch returns null when queued (per orchestrator contract).
      const response = await result.current.dispatchDownload(
        makeFileEntry("welcome.pdf"),
        { shiftKey: false },
        "ds-1",
      );
      expect(response).toBeNull();
    });

    expect(api.download).not.toHaveBeenCalled();
    expect(api.showSaveDialog).not.toHaveBeenCalled();
    expect(result.current.modalOpen).toBe(true);
  });

  it("(f) modal onCommit(folder) flushes the queued download against the now-set folder; ref is cleared", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useDownloadOrchestrator({ api }));

    // Queue a download (no default folder yet).
    await act(async () => {
      await result.current.dispatchDownload(
        makeFileEntry("welcome.pdf"),
        { shiftKey: false },
        "ds-1",
      );
    });

    expect(result.current.modalOpen).toBe(true);
    expect(api.download).not.toHaveBeenCalled();

    // Simulate the modal's onCommit firing. The hook's onCommit is the
    // callback `<FirstDownloadModal>` invokes; the modal internally
    // persists the folder via setDefaultFolder() (so localStorage is set
    // when the callback runs).
    await act(async () => {
      localStorage.setItem(
        DOWNLOADS_DEFAULT_FOLDER_KEY,
        "/Users/alice/Downloads/ft5",
      );
      result.current.onModalCommit("/Users/alice/Downloads/ft5");
      // Allow the deferred dispatch to flush.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.download).toHaveBeenCalledTimes(1);
    expect(api.download).toHaveBeenCalledWith({
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "/Users/alice/Downloads/ft5/welcome.pdf",
    });
    // Modal closes after commit.
    expect(result.current.modalOpen).toBe(false);
  });
});
