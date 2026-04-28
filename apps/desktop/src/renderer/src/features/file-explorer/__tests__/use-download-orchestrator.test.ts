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
  joinFolderAndName,
  sanitizeFilenameForOS,
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

// Post-archive bug-fix follow-up — Bug 2: host-aware join.
// The pre-fix `joinFolderAndName` hard-coded `/` between folder and
// filename. On Windows a folder picked via Electron's directory picker
// arrives as `C:\Users\dev2\Downloads\ft5` (backslashes); joining with
// `/` produced `C:\Users\dev2\Downloads\ft5/welcome.pdf` (mixed
// separators). The service's `path.normalize(input) === input`
// validator (the post-archive defence-in-depth from §6.5) rejects that
// because Windows' `path.normalize` rewrites the `/` to `\`. Every
// download silently failed at validation. The post-fix joiner derives
// the separator from the folder string itself.
describe("joinFolderAndName — host-aware separator (post-archive bug fix)", () => {
  it("uses '/' for a POSIX folder", () => {
    expect(
      joinFolderAndName("/Users/alice/Downloads/ft5", "welcome.pdf"),
    ).toBe("/Users/alice/Downloads/ft5/welcome.pdf");
  });

  it("uses '\\' for a Windows folder containing backslashes", () => {
    // Source string at runtime is `C:\Users\dev2\Downloads\ft5`.
    expect(
      joinFolderAndName(
        "C:\\Users\\dev2\\Downloads\\ft5",
        "welcome.pdf",
      ),
    ).toBe("C:\\Users\\dev2\\Downloads\\ft5\\welcome.pdf");
  });

  it("strips a trailing '/' on the folder before joining", () => {
    expect(
      joinFolderAndName("/Users/alice/Downloads/ft5/", "welcome.pdf"),
    ).toBe("/Users/alice/Downloads/ft5/welcome.pdf");
  });

  it("strips a trailing '\\' on the folder before joining", () => {
    expect(
      joinFolderAndName(
        "C:\\Users\\dev2\\Downloads\\ft5\\",
        "welcome.pdf",
      ),
    ).toBe("C:\\Users\\dev2\\Downloads\\ft5\\welcome.pdf");
  });

  it("strips a leading separator on the filename before joining", () => {
    expect(
      joinFolderAndName("/Users/alice/Downloads/ft5", "/welcome.pdf"),
    ).toBe("/Users/alice/Downloads/ft5/welcome.pdf");
  });

  // Post-archive smoke-2 (2026-04-28): sanitization must run BEFORE the
  // join so vendor-side characters that are valid on Drive (`:`, `/`, etc.)
  // but invalid on Windows are scrubbed before the path crosses IPC.
  it("sanitizes Windows-invalid characters in the filename via joinFolderAndName", () => {
    expect(
      joinFolderAndName("C:\\Users\\dev2\\Downloads\\ft5", "Acme: Test.docx"),
    ).toBe("C:\\Users\\dev2\\Downloads\\ft5\\Acme_ Test.docx");
  });

  it("sanitizes Windows reserved device names in the filename via joinFolderAndName", () => {
    expect(
      joinFolderAndName("C:\\Users\\dev2\\Downloads\\ft5", "CON.txt"),
    ).toBe("C:\\Users\\dev2\\Downloads\\ft5\\_CON.txt");
  });
});

// Post-archive smoke-2 (2026-04-28): the renderer is the only layer that
// knows the local OS context — the engine's source `path` / `handle` can
// reference Drive's `Acme: Test file` happily by handle, but the local
// `toPath` must pass `path.normalize === input` AND survive Windows'
// stricter filename grammar. This sanitizer lives at the renderer's
// `joinFolderAndName` boundary so the cleaned-up name is what crosses IPC.
describe("sanitizeFilenameForOS — Windows-friendly filename scrubbing", () => {
  it("replaces ':' with '_' (colon is invalid on Windows; preserves spacing)", () => {
    expect(sanitizeFilenameForOS("Acme: Test file.docx")).toBe(
      "Acme_ Test file.docx",
    );
  });

  it("replaces '/' (forward slash) inside a filename with '_' (invalid as filename char on Windows)", () => {
    expect(sanitizeFilenameForOS("Q1 / Q2 Report.pdf")).toBe(
      "Q1 _ Q2 Report.pdf",
    );
  });

  it("prefixes Windows reserved device names with '_' (basename-only check; case-insensitive)", () => {
    expect(sanitizeFilenameForOS("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFilenameForOS("con.txt")).toBe("_con.txt");
    expect(sanitizeFilenameForOS("PRN")).toBe("_PRN");
    expect(sanitizeFilenameForOS("COM1.dat")).toBe("_COM1.dat");
    expect(sanitizeFilenameForOS("LPT9")).toBe("_LPT9");
  });

  it("does NOT prefix when the basename merely contains a reserved name as a substring", () => {
    // `CONNECTION` starts with `CON` but isn't the device name itself.
    expect(sanitizeFilenameForOS("CONNECTION.txt")).toBe("CONNECTION.txt");
    expect(sanitizeFilenameForOS("PRNT.log")).toBe("PRNT.log");
  });

  it("strips trailing dots (Windows refuses files ending in '.')", () => {
    expect(sanitizeFilenameForOS("file.txt.")).toBe("file.txt");
  });

  it("strips trailing whitespace (Windows refuses files ending in space)", () => {
    expect(sanitizeFilenameForOS("file.txt  ")).toBe("file.txt");
  });

  it("strips leading whitespace and dots", () => {
    expect(sanitizeFilenameForOS("  ..weird")).toBe("weird");
  });

  it("returns '_unnamed_' when whitespace + dots are the only chars (trim pass empties the string)", () => {
    expect(sanitizeFilenameForOS(" ")).toBe("_unnamed_");
    expect(sanitizeFilenameForOS("...")).toBe("_unnamed_");
    expect(sanitizeFilenameForOS("  . .  ")).toBe("_unnamed_");
  });

  it("replaces an all-invalid-chars filename with all underscores (substitution, NOT empty fallback)", () => {
    // Invalid chars get replaced with `_` BEFORE the trim pass, so an
    // input that's all-invalid emerges as a string of `_`s — distinct
    // from the empty-after-trim case which falls back to `_unnamed_`.
    expect(sanitizeFilenameForOS('<>:"/\\|?*')).toBe("_________");
    expect(sanitizeFilenameForOS("\x00\x01")).toBe("__");
  });

  it("leaves a benign filename unchanged", () => {
    expect(sanitizeFilenameForOS("normal.pdf")).toBe("normal.pdf");
    expect(sanitizeFilenameForOS("Report 2024 (Q1).docx")).toBe(
      "Report 2024 (Q1).docx",
    );
  });

  it("replaces every Windows-invalid char in one pass", () => {
    expect(sanitizeFilenameForOS('a<b>c:d"e/f\\g|h?i*j.txt')).toBe(
      "a_b_c_d_e_f_g_h_i_j.txt",
    );
  });

  it("replaces C0 control chars with '_'", () => {
    // \x07 (BEL) survives as a non-trim char; gets replaced with `_`.
    expect(sanitizeFilenameForOS("a\x07b.txt")).toBe("a_b.txt");
  });
});
