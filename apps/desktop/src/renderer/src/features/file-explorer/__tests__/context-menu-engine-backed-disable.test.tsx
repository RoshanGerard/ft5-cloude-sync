/** @vitest-environment jsdom */
//
// Section 6 — context-menu Rename and Download gate for engine-backed
// datasources. Mounts the FileContextMenu directly under a
// ProviderKindContext to exercise both branches (engine-backed →
// disabled + tooltip; mock → enabled).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import type { FileEntry } from "@ft5/ipc-contracts";

import { FileContextMenu } from "../context-menu";
import { ProviderKindContext } from "../provider-kind-context";
import type { ProviderKind } from "../search-results";

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

function openMenu(providerKind: ProviderKind) {
  const entry = makeEntry();
  const onRename = vi.fn();
  const onDownload = vi.fn();
  render(
    <ProviderKindContext.Provider value={providerKind}>
      <FileContextMenu
        entry={entry}
        onRename={onRename}
        onDownload={onDownload}
      >
        <div data-testid="trigger-row" tabIndex={0}>
          row
        </div>
      </FileContextMenu>
    </ProviderKindContext.Provider>,
  );
  const trigger = screen.getByTestId("trigger-row");
  fireEvent.contextMenu(trigger);
  return { onRename, onDownload };
}

describe("FileContextMenu — engine-backed disable rules", () => {
  afterEach(cleanup);

  it("engine-backed providerKind (google-drive): Rename + Download aria-disabled with spec tooltip", async () => {
    openMenu("google-drive");

    const rename = await waitFor(() =>
      screen.getByTestId("file-context-menu-rename"),
    );
    const download = screen.getByTestId("file-context-menu-download");

    expect(rename.getAttribute("aria-disabled")).toBe("true");
    expect(download.getAttribute("aria-disabled")).toBe("true");
    expect(rename.getAttribute("title")).toContain(
      "add-engine-rename-download",
    );
    expect(download.getAttribute("title")).toContain(
      "add-engine-rename-download",
    );
  });

  it("engine-backed providerKind (onedrive): same treatment as google-drive", async () => {
    openMenu("onedrive");
    const rename = await waitFor(() =>
      screen.getByTestId("file-context-menu-rename"),
    );
    expect(rename.getAttribute("aria-disabled")).toBe("true");
  });

  it("engine-backed providerKind (s3): same treatment", async () => {
    openMenu("s3");
    const rename = await waitFor(() =>
      screen.getByTestId("file-context-menu-rename"),
    );
    expect(rename.getAttribute("aria-disabled")).toBe("true");
  });

  it("mock providerKind: Rename + Download remain enabled; no tooltip", async () => {
    const { onRename } = openMenu("mock");

    const rename = await waitFor(() =>
      screen.getByTestId("file-context-menu-rename"),
    );
    const download = screen.getByTestId("file-context-menu-download");

    expect(rename.getAttribute("aria-disabled")).not.toBe("true");
    expect(download.getAttribute("aria-disabled")).not.toBe("true");
    expect(rename.getAttribute("title")).toBeNull();
    expect(download.getAttribute("title")).toBeNull();

    fireEvent.click(rename);
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("engine-backed: activating a disabled Rename is a no-op (no callback fired)", async () => {
    const { onRename, onDownload } = openMenu("google-drive");

    const rename = await waitFor(() =>
      screen.getByTestId("file-context-menu-rename"),
    );
    const download = screen.getByTestId("file-context-menu-download");

    // Radix ContextMenuItem with `disabled` prop blocks selection entirely;
    // clicking should not invoke the callbacks.
    fireEvent.click(rename);
    fireEvent.click(download);

    expect(onRename).not.toHaveBeenCalled();
    expect(onDownload).not.toHaveBeenCalled();
  });
});
