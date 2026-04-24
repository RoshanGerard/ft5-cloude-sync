/** @vitest-environment jsdom */
//
// Section 6.5 — guardrail that `store.startEdit` is never invoked from the
// file-explorer composite when the datasource is engine-backed, regardless
// of how the rename is triggered (F2 keyboard, context menu click).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
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

import { FileExplorer } from "../file-explorer";
import {
  __resetExplorerStoreCacheForTests,
  getOrCreateExplorerStore,
} from "../store";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
}));

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

function installApi() {
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
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          entries: [
            makeEntry({ id: "e-a", name: "alpha.txt", path: "/alpha.txt" }),
          ],
          truncated: false,
        },
      }),
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

beforeEach(() => {
  window.localStorage.clear();
  __resetExplorerStoreCacheForTests();
  installApi();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("FileExplorer — rename guardrail for engine-backed datasources", () => {
  it("engine-backed (google-drive): F2 on an entry does NOT call store.startEdit", async () => {
    const store = getOrCreateExplorerStore("ds-guard-1");
    const startEditSpy = vi.spyOn(store, "startEdit");

    render(
      <FileExplorer datasourceId="ds-guard-1" providerKind="google-drive" />,
    );

    // Wait for the entry to render.
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-testid="explorer-row"]',
      );
      if (found === null) throw new Error("row not found");
      return found;
    });

    // Focus the row, then press F2.
    // Click to set selection + focus, then fire F2 against the row.
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "F2" });

    expect(startEditSpy).not.toHaveBeenCalled();
  });

  it("mock datasource: F2 on an entry DOES call store.startEdit", async () => {
    const store = getOrCreateExplorerStore("ds-guard-2");
    const startEditSpy = vi.spyOn(store, "startEdit");

    render(<FileExplorer datasourceId="ds-guard-2" providerKind="mock" />);

    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-testid="explorer-row"]',
      );
      if (found === null) throw new Error("row not found");
      return found;
    });

    // Click to set selection + focus, then fire F2 against the row.
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "F2" });

    expect(startEditSpy).toHaveBeenCalledTimes(1);
  });

  it("engine-backed: clicking the (now disabled) context-menu Rename item does NOT call startEdit", async () => {
    const store = getOrCreateExplorerStore("ds-guard-3");
    const startEditSpy = vi.spyOn(store, "startEdit");

    render(
      <FileExplorer datasourceId="ds-guard-3" providerKind="google-drive" />,
    );

    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-testid="explorer-row"]',
      );
      if (found === null) throw new Error("row not found");
      return found;
    });

    fireEvent.contextMenu(row);
    const renameItem = await waitFor(() =>
      screen.getByTestId("file-context-menu-rename"),
    );
    fireEvent.click(renameItem);

    expect(startEditSpy).not.toHaveBeenCalled();
  });
});
