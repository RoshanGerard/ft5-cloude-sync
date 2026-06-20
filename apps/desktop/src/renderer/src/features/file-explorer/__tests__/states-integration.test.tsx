/** @vitest-environment jsdom */
//
// Composite-level integration tests for the five state branches introduced by
// Section 5 of wire-file-explorer-to-service. Each case mounts the real
// `<FileExplorer>` composite against a mocked `window.api.files.list` and
// asserts the correct state component is rendered.

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

import { FilesErrorTag } from "@ft5/ipc-contracts";
import type { FileEntry } from "@ft5/ipc-contracts";

import { FileExplorer } from "../file-explorer";
import { __resetExplorerStoreCacheForTests } from "../store";
import { DatasourcesProvider } from "@/features/datasources/store";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
}));

type ListFn = Mock<
  [{ datasourceId: string; path: string }],
  Promise<unknown>
>;

let listMock: ListFn;

function installApi(listImpl: (req: { path: string }) => Promise<unknown>) {
  listMock = vi.fn(listImpl) as unknown as ListFn;
  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: vi.fn(),
      remove: vi.fn().mockResolvedValue({ ok: true }),
      action: vi.fn(),
      startConsent: vi.fn().mockResolvedValue({ sessionId: "sess-1" }),
      cancelConsent: vi.fn(),
      upload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      // The DatasourcesProvider attaches an `onEvent` listener for consent
      // events (store.tsx:672-691). Tests that wrap the explorer in the
      // provider need this stub so the provider mounts cleanly. Tests that
      // do not wrap simply ignore it.
      onEvent: vi.fn().mockImplementation(() => () => {}),
    },
    files: {
      list: listMock,
      stat: vi.fn(),
      search: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      download: vi.fn(),
    },
  };
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
}

function makeEntry(over: Partial<FileEntry> = {}): FileEntry {
  return {
    id: "e1",
    kind: "file",
    name: "a.txt",
    path: "/a.txt",
    parentPath: "/",
    size: 10,
    mimeFamily: "text",
    mimeType: null,
    modifiedAt: "2026-04-01T00:00:00.000Z",
    createdAt: null,
    providerMetadata: {},
    ...over,
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

describe("FileExplorer — state branch integration", () => {
  it("renders DisconnectedState when files.list rejects with tag:'disconnected'", async () => {
    installApi(async () => ({
      ok: false,
      error: {
        tag: FilesErrorTag.Disconnected,
        message: "Network unreachable",
        retryable: true,
      },
    }));

    render(<FileExplorer datasourceId="ds-state-1" />);

    await waitFor(() =>
      expect(
        screen.getByTestId("file-explorer-state-disconnected"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("file-explorer-state-auth-revoked"),
    ).toBeNull();
    expect(screen.queryByTestId("file-explorer-skeleton")).toBeNull();
  });

  it("renders AuthRevokedState when files.list rejects with tag:'auth-revoked' (engine wins over connected store)", async () => {
    installApi(async () => ({
      ok: false,
      error: {
        tag: FilesErrorTag.AuthRevoked,
        message: "Refresh token expired",
        retryable: false,
      },
    }));

    // providerStatus 'connected' is the conflict case: store says OK but
    // engine says auth-revoked. Engine response must win.
    render(
      <FileExplorer datasourceId="ds-state-2" providerStatus="connected" />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("file-explorer-state-auth-revoked"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("explorer-row")).toBeNull();
  });

  it("renders SyncingState pre-response when providerStatus='syncing'", async () => {
    // Keep the list call pending forever so the explorer stays in the
    // "loading + providerStatus=syncing" branch.
    installApi(() => new Promise(() => {}));

    render(
      <FileExplorer datasourceId="ds-state-3" providerStatus="syncing" />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("file-explorer-state-syncing"),
      ).toBeInTheDocument(),
    );
  });

  it("renders EmptyState when files.list resolves with zero entries and providerStatus is connected", async () => {
    installApi(async () => ({
      ok: true,
      value: { entries: [], truncated: false },
    }));

    render(
      <FileExplorer datasourceId="ds-state-4" providerStatus="connected" />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("file-explorer-state-empty"),
      ).toBeInTheDocument(),
    );
  });

  it("renders entries (not SyncingState) when providerStatus='syncing' but list returns non-empty", async () => {
    installApi(async () => ({
      ok: true,
      value: {
        entries: [makeEntry({ id: "e-a", name: "alpha", path: "/alpha" })],
        truncated: false,
      },
    }));

    render(
      <FileExplorer datasourceId="ds-state-5" providerStatus="syncing" />,
    );

    // Wait for the loading flip: the skeleton/syncing state clears and the
    // view-mode switcher renders at least one entry.
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="explorer-row"]').length,
      ).toBe(1),
    );
    expect(
      screen.queryByTestId("file-explorer-state-syncing"),
    ).toBeNull();
  });

  it("renders Skeleton while loading when providerStatus is NOT syncing", async () => {
    installApi(() => new Promise(() => {}));

    render(
      <FileExplorer datasourceId="ds-state-6" providerStatus="connected" />,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("file-explorer-skeleton"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("file-explorer-state-syncing"),
    ).toBeNull();
  });

  it("renders InvalidDatasourceState when files.list rejects with tag:'invalid-datasource'", async () => {
    // §9.1 — new arm. The invalid-datasource branch reaches into
    // `useDatasourceActions` (for the shared confirm-remove dialog) and
    // <InvalidDatasourceState> hits `useConsentSession`, so this render
    // must be inside <DatasourcesProvider>. Other arms above stay
    // unwrapped because they never instantiate either hook.
    installApi(async () => ({
      ok: false,
      error: {
        tag: FilesErrorTag.InvalidDatasource,
        message: "Credentials are missing — reconnect this datasource",
        retryable: false,
      },
    }));

    render(
      <DatasourcesProvider>
        <FileExplorer
          datasourceId="ds-state-7"
          providerId="google-drive"
          providerStatus="error"
        />
      </DatasourcesProvider>,
    );

    await waitFor(() =>
      expect(
        screen.getByTestId("file-explorer-state-invalid-datasource"),
      ).toBeInTheDocument(),
    );
    // Other state components not present.
    expect(
      screen.queryByTestId("file-explorer-state-disconnected"),
    ).toBeNull();
    expect(
      screen.queryByTestId("file-explorer-state-auth-revoked"),
    ).toBeNull();
    expect(screen.queryByTestId("file-explorer-state-empty")).toBeNull();
    expect(
      screen.queryByTestId("file-explorer-error"),
    ).toBeNull();
  });
});
