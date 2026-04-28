/** @vitest-environment jsdom */
//
// add-engine-rename-download §23/§24 follow-up — integration test for
// the file-explorer's handleDownload click path.
//
// Pre-fix the click routed to `store.download(entry.id)`, which dispatched
// `window.api.files.download({ datasourceId, path })` directly and bypassed
// the orchestrator + first-run-modal entirely. After the fix the click
// routes through `useDownloadOrchestrator.dispatchDownload`, which:
//   - persists / reads the default folder via downloads-store
//   - opens the first-run modal when no folder is set, OR
//   - dispatches `window.api.files.download({ datasourceId, path, toPath })`
//     with the resolved toPath
//
// This test asserts the second branch only — the first-run-modal flow has
// its own coverage in `first-download-modal.test.tsx` + `use-download-orchestrator.test.ts`.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { FileEntry } from "@ft5/ipc-contracts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

import { FileExplorer } from "../file-explorer.js";
import { __resetExplorerStoreCacheForTests } from "../store.js";
import { DOWNLOADS_DEFAULT_FOLDER_KEY } from "../../settings/downloads-store.js";
import { seedEntry } from "./test-utils.js";

let downloadMock: Mock;
let showSaveDialogMock: Mock;

function installApiMock(entries: FileEntry[]): void {
  downloadMock = vi.fn().mockResolvedValue({
    ok: true,
    value: { savedPath: "/Users/alice/Downloads/ft5/welcome.pdf", bytes: 1024 },
  });
  showSaveDialogMock = vi.fn();

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: vi.fn(),
      remove: vi.fn(),
      action: vi.fn(),
      pickFilesToUpload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    sync: {
      listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      onEvent: vi.fn().mockReturnValue(() => {}),
      authenticateStart: vi.fn(),
      authenticateComplete: vi.fn(),
      authenticateCancel: vi.fn(),
    },
    files: {
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: { entries, truncated: false },
      }),
      stat: vi.fn(),
      search: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      download: downloadMock,
      onActiveDownloadsHydrate: vi.fn().mockReturnValue(() => {}),
    },
    dialog: {
      showSaveDialog: showSaveDialogMock,
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  __resetExplorerStoreCacheForTests();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("FileExplorer handleDownload wiring (§23/§24 follow-up)", () => {
  it("context-menu Download → orchestrator dispatch with toPath = <defaultFolder>/<filename>; no first-run modal", async () => {
    // Pre-seed the default folder so the first-run-modal branch is bypassed.
    window.localStorage.setItem(
      DOWNLOADS_DEFAULT_FOLDER_KEY,
      "/Users/alice/Downloads/ft5",
    );

    const entry = seedEntry({
      id: "f1",
      name: "welcome.pdf",
      path: "/welcome.pdf",
    });
    installApiMock([entry]);

    render(<FileExplorer datasourceId="ds-1" />);

    // Wait for the row to render (Details view's `explorer-row` testid).
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-testid="explorer-row"]',
      );
      if (found === null) throw new Error("row not found");
      return found;
    });

    // Open the context menu (right-click on the row).
    fireEvent.contextMenu(row);

    // Click the Download menu item by its stable testid.
    const downloadItem = await screen.findByTestId(
      "file-context-menu-download",
    );
    fireEvent.click(downloadItem);

    // Orchestrator → window.api.files.download is called once with the
    // resolved toPath (default folder + filename), NOT the legacy
    // 2-arg shape.
    await waitFor(() => {
      expect(downloadMock).toHaveBeenCalledTimes(1);
    });
    expect(downloadMock).toHaveBeenCalledWith({
      datasourceId: "ds-1",
      path: "/welcome.pdf",
      toPath: "/Users/alice/Downloads/ft5/welcome.pdf",
    });
    // No save-as dialog (no Shift, no Always-ask).
    expect(showSaveDialogMock).not.toHaveBeenCalled();
  });
});
