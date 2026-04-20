/** @vitest-environment jsdom */
//
// Task 2.3 (RED) — File-explorer route page tests.
//
// The explorer route lives at `/datasources/explore` and reads the datasource
// id from the `?id=<datasourceId>` query parameter (see design.md Decision 1
// amended in commit 336f0e8 for static-export compatibility — a dynamic
// `[datasourceId]` file segment would need `generateStaticParams` which breaks
// for runtime-added datasources under `output: "export"`).
//
// Coverage:
//   1. Known `id` + it resolves against the datasources list → the explorer
//      placeholder mounts (data-testid="file-explorer-root") and the per-id
//      store is instantiated (we assert via `useExplorerStore.getSnapshot()`).
//   2. Absent `id` query param → "Datasource not found" error state with a
//      "Return to dashboard" link pointing at `/`.
//   3. Unknown `id` (present but not in the datasources list) → same error
//      state; no `window.api.files.*` IPC is expected (the placeholder would
//      never mount).
//
// Test strategy:
//   - Mock `next/navigation`'s `useSearchParams` via a mutable module-level
//     `currentIdParam` so each case can vary the id without re-mocking.
//   - Mock `window.api.datasources.list()` (same envelope as the real preload
//     returns: `{ datasources: DatasourceSummary[] }`) so Case 3 can exercise
//     the "id present but not in list" branch.
//   - Reset the per-datasource store cache between tests via the
//     `__resetExplorerStoreCacheForTests` test-only helper so IDs don't leak
//     across cases.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DatasourceSummary } from "@ft5/ipc-contracts";

import ExplorePage from "../page";
import {
  __resetExplorerStoreCacheForTests,
  getOrCreateExplorerStore,
} from "@/features/file-explorer/store";

// `currentIdParam` is read by the `useSearchParams` mock below — each test
// reassigns it before rendering so we don't need to re-register the mock.
let currentIdParam: string | null = null;

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => (key === "id" ? currentIdParam : null),
  }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const KNOWN_DATASOURCES: DatasourceSummary[] = [
  {
    id: "ds-gdrive-personal",
    displayName: "Personal Drive",
    providerId: "google-drive",
    status: "connected",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 120,
    usage: { used: 12_000_000_000, quota: 16_000_000_000 },
  },
  {
    id: "ds-onedrive-team",
    displayName: "Team OneDrive",
    providerId: "onedrive",
    status: "connected",
    lastSyncAt: null,
    itemCount: 42,
  },
  {
    id: "ds-s3-archive",
    displayName: "Archive Bucket",
    providerId: "amazon-s3",
    status: "paused",
    lastSyncAt: null,
    itemCount: 9,
  },
];

let listMock: Mock;

function installApiMock(datasources: DatasourceSummary[]): void {
  listMock = vi.fn().mockResolvedValue({ datasources });
  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: listMock,
      add: vi.fn(),
      remove: vi.fn(),
      action: vi.fn(),
      upload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
    },
    files: {
      // Default to an empty folder so the FileExplorer composite's
      // `useExplorerData` hook can drive through loading → populated
      // without needing per-test fixtures here (route tests only assert
      // that the explorer mounts for a known id; per-entry rendering is
      // covered by `file-explorer-composite.test.tsx`).
      list: vi.fn().mockResolvedValue({ entries: [], nextCursor: null }),
      stat: vi.fn(),
      search: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      download: vi.fn(),
    },
  };
}

describe("/datasources/explore route page (task 2.3)", () => {
  beforeEach(() => {
    currentIdParam = null;
    __resetExplorerStoreCacheForTests();
    installApiMock(KNOWN_DATASOURCES);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the explorer placeholder when id resolves to a known datasource", async () => {
    currentIdParam = "ds-gdrive-personal";

    render(<ExplorePage />);

    const root = await screen.findByTestId("file-explorer-root");
    expect(root).toBeInTheDocument();

    // The per-id store should have been instantiated — check the initial
    // snapshot matches the factory defaults (currentPath "/", empty history
    // stack with that single entry). Reading from getOrCreateExplorerStore
    // after render confirms the page wired the same id into the factory.
    const store = getOrCreateExplorerStore("ds-gdrive-personal");
    const snapshot = store.getSnapshot();
    expect(snapshot.currentPath).toBe("/");
    expect(snapshot.history.stack).toEqual(["/"]);
    expect(snapshot.history.index).toBe(0);
  });

  it("renders 'Datasource not found' when the id query parameter is absent", async () => {
    currentIdParam = null;

    render(<ExplorePage />);

    // Error state should appear synchronously — no IPC call is needed to
    // decide there's no id.
    const heading = await screen.findByRole("heading", {
      name: /datasource not found/i,
    });
    expect(heading).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /return to dashboard/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/");

    // The placeholder must NOT be present in the error state.
    expect(screen.queryByTestId("file-explorer-root")).toBeNull();

    // And no datasources.list call should be dispatched for the "no id" case.
    expect(listMock).not.toHaveBeenCalled();
  });

  it("renders 'Datasource not found' when the id is unknown", async () => {
    currentIdParam = "ds-nonexistent";

    render(<ExplorePage />);

    // Error state appears after the datasources.list resolves and the id is
    // not found in the returned list.
    const heading = await screen.findByRole("heading", {
      name: /datasource not found/i,
    });
    expect(heading).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /return to dashboard/i });
    expect(link).toHaveAttribute("href", "/");

    // The placeholder must NOT render for an unknown id.
    expect(screen.queryByTestId("file-explorer-root")).toBeNull();

    // The datasources.list IPC call is issued because we had an id to
    // validate — but the file-explorer placeholder never mounts.
    await waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(1);
    });
  });

  it("mounts the explorer for a different known id (ds-s3-archive)", async () => {
    currentIdParam = "ds-s3-archive";

    render(<ExplorePage />);

    const root = await screen.findByTestId("file-explorer-root");
    expect(root).toBeInTheDocument();

    const store = getOrCreateExplorerStore("ds-s3-archive");
    expect(store.getSnapshot().currentPath).toBe("/");
  });
});
