/** @vitest-environment jsdom */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import type { FileEntry, FilesRenameResponse } from "@ft5/ipc-contracts";

// Sonner mocked so the store's toast.error does not require a <Toaster/>.
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import {
  __resetExplorerStoreCacheForTests,
  createExplorerStore,
} from "../store.js";
import type { ExplorerStore } from "../store.js";
import { DetailsView } from "../view-modes/details.js";
import { seedEntry } from "./test-utils.js";

// Mount DetailsView directly — the inline-rename UI is view-mode-agnostic
// because every view mode routes its name through EntryNameCell.

function makeStore(): ExplorerStore {
  __resetExplorerStoreCacheForTests();
  return createExplorerStore("ds-rename");
}

function installRenameFn(
  fn: (req: {
    datasourceId: string;
    path: string;
    newName: string;
    conflictPolicy: "fail" | "overwrite" | "keep-both";
  }) => Promise<FilesRenameResponse>,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(fn);
  // Attach onto the existing jsdom window (don't clobber it — Radix
  // needs window.clearTimeout / setTimeout on unmount).
  (window as unknown as { api: unknown }).api = { files: { rename: spy } };
  return spy;
}

function seedEntries(store: ExplorerStore, entries: FileEntry[]): void {
  act(() => {
    store.setEntries(entries);
  });
}

describe("inline rename UI", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (window as unknown as { api?: unknown }).api;
  });

  it("renders the entry name as static text when editingId is null", () => {
    const store = makeStore();
    seedEntries(store, [seedEntry({ id: "e1", name: "a.txt", path: "/a.txt" })]);

    render(<DetailsView store={store} />);

    expect(screen.getByText("a.txt")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("flips the entry's name cell to a pre-filled, selected <input> when startEdit is called", () => {
    const store = makeStore();
    seedEntries(store, [
      seedEntry({ id: "e1", name: "report.pdf", path: "/report.pdf" }),
    ]);

    render(<DetailsView store={store} />);

    act(() => {
      store.startEdit("e1");
    });

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe("report.pdf");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("report.pdf".length);
  });

  it("Enter commits: dispatches store.rename with the new value, calling window.api.files.rename once", async () => {
    const renameFn = installRenameFn(async (req) => ({
      ok: true,
      value: {
        entry: seedEntry({
          id: "e1",
          name: req.newName,
          path: `/${req.newName}`,
        }),
      },
    }));
    const store = makeStore();
    seedEntries(store, [seedEntry({ id: "e1", name: "old.txt", path: "/old.txt" })]);

    render(<DetailsView store={store} />);
    act(() => {
      store.startEdit("e1");
    });

    const input = screen.getByRole("textbox") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "new.txt" } });
      fireEvent.keyDown(input, { key: "Enter" });
      // Flush the store.rename promise chain.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renameFn).toHaveBeenCalledTimes(1);
    expect(renameFn).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/old.txt", newName: "new.txt" }),
    );
  });

  it("Escape cancels: input closes, no rename dispatched, editingId returns to null", () => {
    const renameFn = installRenameFn(async () => ({
      ok: true,
      value: { entry: seedEntry({ id: "e1" }) },
    }));
    const store = makeStore();
    seedEntries(store, [seedEntry({ id: "e1", name: "old.txt", path: "/old.txt" })]);

    render(<DetailsView store={store} />);
    act(() => {
      store.startEdit("e1");
    });

    const input = screen.getByRole("textbox");
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(renameFn).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(store.getSnapshot().editingId).toBeNull();
  });

  it("startEdit on a directory entry does NOT render an input", () => {
    const store = makeStore();
    seedEntries(store, [
      seedEntry({
        id: "d1",
        kind: "directory",
        name: "docs",
        path: "/docs",
        size: null,
      }),
    ]);

    render(<DetailsView store={store} />);
    act(() => {
      store.startEdit("d1");
    });

    expect(screen.queryByRole("textbox")).toBeNull();
    // Store surfaces the refusal reason for the caller.
    expect(store.getSnapshot().lastError).toEqual({
      entryId: "d1",
      reason: "Folder rename is not supported in this version",
    });
  });

  it("during a pending rename the cell shows the new requested name (not the old one)", async () => {
    // Deferred promise — rename stays mid-flight so we can assert the
    // optimistic name without a resolved response overwriting it.
    installRenameFn(() => new Promise(() => {}));
    const store = makeStore();
    seedEntries(store, [seedEntry({ id: "e1", name: "old.txt", path: "/old.txt" })]);

    render(<DetailsView store={store} />);
    act(() => {
      store.startEdit("e1");
    });
    const input = screen.getByRole("textbox") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "new.txt" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });

    // Per design.md Decision 7 step 3: "its name is replaced by the new
    // value" while the operation is in flight.
    expect(screen.queryByText("old.txt")).toBeNull();
    expect(screen.getByText("new.txt")).toBeInTheDocument();
  });

  it("while a pendingOp (kind=rename) is active the input is NOT rendered and the row is opacity-60", () => {
    const store = makeStore();
    seedEntries(store, [seedEntry({ id: "e1", name: "old.txt", path: "/old.txt" })]);

    render(<DetailsView store={store} />);
    act(() => {
      // Simulate mid-flight rename: pendingOp set before the response resolves.
      store.startPendingOp("e1", "rename");
    });

    // No input even if editingId were set (precedence: pendingOp beats editing).
    act(() => {
      store.startEdit("e1");
    });
    expect(screen.queryByRole("textbox")).toBeNull();

    // The name cell carries opacity-60 styling while pending.
    const nameCell = screen.getByTestId("explorer-cell-name");
    expect(nameCell.className).toMatch(/\bopacity-60\b/);
  });
});
