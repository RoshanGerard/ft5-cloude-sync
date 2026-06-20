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
import { FilesErrorTag } from "@ft5/ipc-contracts";
import type { FileEntry } from "@ft5/ipc-contracts";

// FileExplorer now calls `useRouter()` for the back-to-dashboard button.
// Mock `next/navigation` so the App Router invariant ("expected app router
// to be mounted") doesn't fire under vitest's non-App-Router host.
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
import {
  __resetExplorerStoreCacheForTests,
  getOrCreateExplorerStore,
} from "../store.js";
import { seedEntry } from "./test-utils.js";
import { DatasourcesProvider } from "@/features/datasources/store";

let filesListMock: Mock;
let authenticateStartMock: Mock;
let removeMock: Mock;
let syncOnEventCapture: ((event: unknown) => void) | null = null;

interface InstallOptions {
  // Optional canned responses per path call; default is "empty". The inner
  // shape mirrors `FilesListValue`; `nextCursor` is tolerated as a legacy
  // field but ignored — the new envelope uses `truncated` only.
  responses?: Map<
    string,
    { entries: FileEntry[]; truncated?: boolean; nextCursor?: string | null }
  >;
  // If set, the `files.list` mock rejects with this error.
  reject?: Error;
  // A deferred promise the test can resolve manually — useful for the
  // cancellation / loading-state cases.
  defer?: boolean;
  // Custom impl for `files.list`, used by the §9.2 invalid-datasource arm
  // which needs to flip the response between successive calls.
  listImpl?: (req: { path: string }) => Promise<unknown>;
}

function installApiMock(options: InstallOptions = {}): void {
  filesListMock = vi.fn();
  if (options.reject) {
    filesListMock.mockRejectedValue(options.reject);
  } else if (options.listImpl) {
    filesListMock.mockImplementation(options.listImpl);
  } else if (options.defer) {
    // Defer-mode: each call returns a fresh, never-auto-resolving promise.
    // Tests that care about ordering grab promises out of the mock.
    filesListMock.mockImplementation(() => new Promise(() => {}));
  } else {
    const responses = options.responses ?? new Map();
    filesListMock.mockImplementation(async (req: { path: string }) => {
      const canned = responses.get(req.path);
      const inner = canned ?? { entries: [] };
      return {
        ok: true as const,
        value: {
          entries: inner.entries,
          truncated: inner.truncated ?? false,
        },
      };
    });
  }

  authenticateStartMock = vi.fn().mockResolvedValue({
    ok: true,
    result: { correlationId: "corr-inv-1", kind: "oauth" },
  });
  removeMock = vi.fn().mockResolvedValue({ ok: true });
  syncOnEventCapture = null;

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: vi.fn(),
      remove: removeMock,
      action: vi.fn(),
      pickFilesToUpload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    sync: {
      listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      onEvent: vi.fn().mockImplementation((cb: (e: unknown) => void) => {
        syncOnEventCapture = cb;
        return () => {
          syncOnEventCapture = null;
        };
      }),
      authenticateStart: authenticateStartMock,
      authenticateComplete: vi.fn(),
      authenticateCancel: vi
        .fn()
        .mockResolvedValue({ ok: true, result: { cancelled: true } }),
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

    // Called with the expected payload at least once. `objectContaining`
    // because the request now also carries `pageSize` (add-engine-
    // listdirectory-pagination §8.7 — page size is read from localStorage
    // on every list origination); this assertion pins only the identity +
    // path, which is what this case is about.
    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalledWith(
        expect.objectContaining({
          datasourceId: "ds-gdrive-personal",
          path: "/",
        }),
      );
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
      expect(filesListMock).toHaveBeenCalledWith(
        expect.objectContaining({
          datasourceId: "ds-gdrive-personal",
          path: "/photos",
        }),
      );
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

  // Regression: double-click on a directory should navigate into it, matching
  // the universal file-explorer gesture. Single click selects; right-click
  // Open also navigates; this test covers the double-click path specifically.
  // The original Phase 4 composite did not wire `onDoubleClick` on any view-
  // mode cell, so the user had to right-click → Open. Fixed by passing
  // `onDoubleClick={() => onOpen?.(entry)}` through every cell's spread.
  it("double-clicking a directory navigates into it and re-fetches entries", async () => {
    const root = [
      seedEntry({
        id: "d1",
        name: "reports",
        path: "/reports",
        kind: "directory",
        size: null,
        mimeFamily: "unknown",
        mimeType: null,
      }),
    ];
    const reports = [
      seedEntry({ id: "r1", name: "q1.pdf", path: "/reports/q1.pdf" }),
    ];
    installApiMock({
      responses: new Map([
        ["/", { entries: root, nextCursor: null }],
        ["/reports", { entries: reports, nextCursor: null }],
      ]),
    });

    render(<FileExplorer datasourceId="ds-gdrive-personal" />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });

    const dirRow = document.querySelector(
      '[data-testid="explorer-row"][data-entry-id="d1"]',
    );
    expect(dirRow).not.toBeNull();

    fireEvent.doubleClick(dirRow!);

    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalledWith(
        expect.objectContaining({
          datasourceId: "ds-gdrive-personal",
          path: "/reports",
        }),
      );
    });

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid="explorer-row"]').length).toBe(1);
    });
    expect(
      document.querySelector('[data-entry-id="r1"]'),
    ).not.toBeNull();
  });

  // §9.2 — invalid-datasource branch round-trip (post §27 migration). The
  // first list() call returns an `invalid-datasource` error envelope,
  // prompting the explorer to render <InvalidDatasourceState>. Clicking
  // Reconnect calls `sync.authenticateStart`; emitting an `auth-completed`
  // SyncEvent drives `useAuthSession` to the completed state, which fires
  // the component's `onReconnectSucceeded` → the explorer wires this to
  // `store.retryLoad()`. The next list() call returns a real entry; the
  // explorer transitions out of the invalid-datasource arm and the entry
  // rows render. <DatasourcesProvider> is required because both
  // <InvalidDatasourceState> (useAuthSession) and the file-explorer's
  // invalid-datasource arm (useDatasourceActions) read context.
  it("invalid-datasource → Reconnect → auth-completed → entries render", async () => {
    let phase: "invalid" | "ok" = "invalid";
    installApiMock({
      listImpl: async () => {
        if (phase === "invalid") {
          return {
            ok: false as const,
            error: {
              tag: FilesErrorTag.InvalidDatasource,
              message: "Credentials are missing — reconnect this datasource",
              retryable: false,
            },
          };
        }
        return {
          ok: true as const,
          value: {
            entries: [
              seedEntry({
                id: "x1",
                name: "after.txt",
                path: "/after.txt",
              }),
            ],
            truncated: false,
          },
        };
      },
    });

    render(
      <DatasourcesProvider>
        <FileExplorer
          datasourceId="ds-invalid-1"
          providerId="google-drive"
        />
      </DatasourcesProvider>,
    );

    // The state component renders.
    await waitFor(() =>
      expect(
        screen.getByTestId("file-explorer-state-invalid-datasource"),
      ).toBeInTheDocument(),
    );

    // Click Reconnect → sync.authenticateStart({providerId, datasourceId}).
    fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    await waitFor(() => {
      expect(authenticateStartMock).toHaveBeenCalledTimes(1);
    });
    expect(authenticateStartMock.mock.calls[0]![0]).toEqual({
      providerId: "google-drive",
      datasourceId: "ds-invalid-1",
    });

    // Flip the next list response to ok BEFORE emitting auth-completed so
    // the retryLoad fetch lands the success branch.
    phase = "ok";

    // Drive the auth-completed sync event via the captured sync.onEvent
    // listener. This pushes `useAuthSession` into the `completed` state,
    // <InvalidDatasourceState> fires its `onReconnectSucceeded` callback,
    // which the explorer wires to `store.retryLoad()`.
    expect(syncOnEventCapture).not.toBeNull();
    act(() => {
      syncOnEventCapture!({
        kind: "auth-completed",
        payload: {
          correlationId: "corr-inv-1",
          datasourceId: "ds-invalid-1",
          summary: {
            id: "ds-invalid-1",
            providerId: "google-drive",
            displayName: "ds",
            status: "connected",
            errorReason: null,
            errorKind: null,
            paused: false,
            lastSyncAt: null,
            itemCount: 0,
          },
        },
      });
    });

    // The state component unmounts and the entry from the second list()
    // response renders.
    await waitFor(() => {
      expect(
        screen.queryByTestId("file-explorer-state-invalid-datasource"),
      ).toBeNull();
    });
    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-testid="explorer-row"]').length,
      ).toBe(1);
    });
    expect(document.querySelector('[data-entry-id="x1"]')).not.toBeNull();
  });
});
