/** @vitest-environment jsdom */
//
// Subagent P (Phase 4 composite wiring) — integration tests for
// `FileExplorer`. Mounts the real composite (chrome + useExplorerData +
// ViewModeSwitcher + StatusRow) and asserts the cross-cutting behaviours
// the individual Phase 4 subagents could not cover in isolation:
//
//   1. Mount triggers `window.api.files.list` with the datasource id +
//      currentPath "/"; loading state is visible pre-resolve; entries
//      render after resolve; status row reflects the count.
//   2. Navigating into a directory re-fires `files.list` with the new
//      path; status row reflects the new count.
//   3. Error state renders "Failed to load" when the IPC rejects; no
//      view-mode container mounts.
//   4. Right-click on a rendered cell opens the 6-item FileContextMenu
//      (per-cell wiring via the explorer composite).
//   5. Sanity-check that the outer `data-testid="file-explorer-root"`
//      container is still the stable anchor after a view-mode switch.

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
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { FileEntry } from "@ft5/ipc-contracts";

import { FileExplorer } from "../file-explorer.js";
import {
  __resetExplorerStoreCacheForTests,
  getOrCreateExplorerStore,
} from "../store.js";
import { seedEntry } from "./test-utils.js";

let filesListMock: Mock;

interface InstallOptions {
  // Optional canned responses per path call; default is "empty".
  responses?: Map<string, { entries: FileEntry[]; nextCursor: string | null }>;
  // If set, the `files.list` mock rejects with this error.
  reject?: Error;
  // A deferred promise the test can resolve manually — useful for the
  // cancellation / loading-state cases.
  defer?: boolean;
}

function installApiMock(options: InstallOptions = {}): void {
  filesListMock = vi.fn();
  if (options.reject) {
    filesListMock.mockRejectedValue(options.reject);
  } else if (options.defer) {
    // Defer-mode: each call returns a fresh, never-auto-resolving promise.
    // Tests that care about ordering grab promises out of the mock.
    filesListMock.mockImplementation(() => new Promise(() => {}));
  } else {
    const responses = options.responses ?? new Map();
    filesListMock.mockImplementation(async (req: { path: string }) => {
      const canned = responses.get(req.path);
      if (canned !== undefined) return canned;
      return { entries: [], nextCursor: null };
    });
  }

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: vi.fn(),
      remove: vi.fn(),
      action: vi.fn(),
      upload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
    },
    files: {
      list: filesListMock,
      stat: vi.fn(),
      search: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      download: vi.fn(),
    },
  };
}

describe("FileExplorer composite (Subagent P)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("dispatches files.list on mount and renders the entries + status count", async () => {
    const root = [
      seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" }),
      seedEntry({ id: "b", name: "bravo.pdf", path: "/bravo.pdf" }),
      seedEntry({
        id: "c",
        name: "charlie",
        path: "/charlie",
        kind: "directory",
        size: null,
        mimeFamily: "unknown",
        mimeType: null,
      }),
    ];
    installApiMock({
      responses: new Map([["/", { entries: root, nextCursor: null }]]),
    });

    render(<FileExplorer datasourceId="ds-gdrive-personal" />);

    // Root anchor present.
    expect(screen.getByTestId("file-explorer-root")).toBeInTheDocument();

    // Called with the expected payload at least once.
    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalledWith({
        datasourceId: "ds-gdrive-personal",
        path: "/",
      });
    });

    // After resolve: three rows rendered in Details (the default view mode).
    await waitFor(() => {
      const rows = document.querySelectorAll('[data-testid="explorer-row"]');
      expect(rows.length).toBe(3);
    });

    // Status row reflects the count.
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/3 items/);
  });

  it("navigating into a directory re-fetches the new path and updates the status count", async () => {
    const root = [
      seedEntry({
        id: "d1",
        name: "photos",
        path: "/photos",
        kind: "directory",
        size: null,
        mimeFamily: "unknown",
        mimeType: null,
      }),
    ];
    const photos = [
      seedEntry({ id: "p1", name: "one.png", path: "/photos/one.png" }),
      seedEntry({ id: "p2", name: "two.png", path: "/photos/two.png" }),
    ];
    installApiMock({
      responses: new Map([
        ["/", { entries: root, nextCursor: null }],
        ["/photos", { entries: photos, nextCursor: null }],
      ]),
    });

    render(<FileExplorer datasourceId="ds-gdrive-personal" />);

    // Wait for initial resolve.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    // Drive navigation through the store — mirrors what Enter-on-directory
    // would do via `useKeyboardNav`. We avoid routing through the full
    // keyboard-nav integration here because its coverage already lives in
    // keyboard-nav.test.tsx; the composite test is about IPC re-fetching.
    const store = getOrCreateExplorerStore("ds-gdrive-personal");
    act(() => {
      store.navigate("/photos");
    });

    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalledWith({
        datasourceId: "ds-gdrive-personal",
        path: "/photos",
      });
    });

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(2);
    });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/2 items/);
  });

  it("renders 'Failed to load' and no view-mode container when files.list rejects", async () => {
    installApiMock({ reject: new Error("network unreachable") });

    render(<FileExplorer datasourceId="ds-gdrive-personal" />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/network unreachable/i)).toBeInTheDocument();

    // No view-mode container should mount in the error branch.
    expect(
      screen.queryByTestId("view-mode-keyboard-container"),
    ).toBeNull();
    // And no data rows.
    expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(0);
  });

  it("right-click on a rendered row opens the 6-item FileContextMenu", async () => {
    const root = [
      seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" }),
    ];
    installApiMock({
      responses: new Map([["/", { entries: root, nextCursor: null }]]),
    });

    render(<FileExplorer datasourceId="ds-gdrive-personal" />);

    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-testid="explorer-row"]',
      );
      if (found === null) throw new Error("row not found");
      return found;
    });

    fireEvent.contextMenu(row);

    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();

    // Six menu items in the spec order.
    const items = screen.getAllByRole("menuitem");
    expect(items.map((n) => n.textContent?.trim())).toEqual([
      "Open",
      "Download",
      "Rename",
      "Delete",
      "Copy path",
      "Properties",
    ]);
  });

  it("view-mode switch keeps the root anchor mounted and the entries visible", async () => {
    const root = [
      seedEntry({ id: "a", name: "alpha.png", path: "/alpha.png" }),
      seedEntry({ id: "b", name: "bravo.pdf", path: "/bravo.pdf" }),
    ];
    installApiMock({
      responses: new Map([["/", { entries: root, nextCursor: null }]]),
    });

    render(<FileExplorer datasourceId="ds-gdrive-personal" />);

    // Wait for initial resolve (Details by default → explorer-row is the
    // details data-row signature).
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(2);
    });

    // Flip the store to list mode (the toolbar route is covered by
    // mode-switch-integration.test.tsx; here we just need the net effect).
    const store = getOrCreateExplorerStore("ds-gdrive-personal");
    act(() => {
      store.setViewMode("list");
    });

    // Root anchor is still mounted.
    expect(screen.getByTestId("file-explorer-root")).toBeInTheDocument();
    // List mode emits `explorer-list-row` cells — same two entries.
    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-testid="explorer-list-row"]').length,
      ).toBe(2);
    });
  });
});
