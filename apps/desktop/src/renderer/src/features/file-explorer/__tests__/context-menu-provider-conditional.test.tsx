/** @vitest-environment jsdom */
//
// Section 19 — context-menu Rename and Download, provider-conditional
// gate. Validates the post-`add-engine-rename-download` rule:
//
//   - Rename: enabled for files on every provider; enabled for
//     Drive/OneDrive directories; disabled for S3 directories with the
//     provider-specific tooltip; disabled for mock directories with the
//     existing v1 tooltip.
//   - Download: enabled for files on every provider; disabled for
//     directories on every provider with the v1 tooltip.
//
// Mirrors the spec's "Rename and Download affordances are enabled with
// provider-conditional folder rename" requirement in
// `openspec/changes/add-engine-rename-download/specs/file-explorer/spec.md`.

import { afterEach, describe, expect, it } from "vitest";
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

const FILE_TOOLTIP_RENAME_S3 = "Folder rename isn't supported on S3";
const FILE_TOOLTIP_RENAME_MOCK =
  "Folder rename is not supported in this version";
const FILE_TOOLTIP_DOWNLOAD_DIR =
  "Folder download is not supported in this version";

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

function directoryEntry(over: Partial<FileEntry> = {}): FileEntry {
  return makeEntry({
    id: "dir-1",
    kind: "directory",
    name: "projects",
    path: "/projects",
    size: null,
    mimeFamily: "unknown",
    mimeType: null,
    ...over,
  });
}

function openMenuFor(
  providerKind: ProviderKind,
  entry: FileEntry,
): void {
  render(
    <ProviderKindContext.Provider value={providerKind}>
      <FileContextMenu entry={entry}>
        <div data-testid="trigger-row" tabIndex={0}>
          row
        </div>
      </FileContextMenu>
    </ProviderKindContext.Provider>,
  );
  const trigger = screen.getByTestId("trigger-row");
  fireEvent.contextMenu(trigger);
}

async function getRenameItem(): Promise<HTMLElement> {
  return waitFor(() => screen.getByTestId("file-context-menu-rename"));
}

async function getDownloadItem(): Promise<HTMLElement> {
  return waitFor(() => screen.getByTestId("file-context-menu-download"));
}

describe("FileContextMenu — provider-conditional Rename and Download", () => {
  afterEach(cleanup);

  // §19.1 — failing baseline test: Drive file Rename + Download must be
  // enabled (no aria-disabled). Pre-§19 implementation marks engine-backed
  // providers as disabled, so this fails until the gate is flipped.
  it("Google Drive file: Rename and Download are enabled with no tooltip", async () => {
    openMenuFor("google-drive", makeEntry());

    const rename = await getRenameItem();
    const download = await getDownloadItem();

    expect(rename.getAttribute("aria-disabled")).not.toBe("true");
    expect(download.getAttribute("aria-disabled")).not.toBe("true");
    expect(rename.getAttribute("title")).toBeNull();
    expect(download.getAttribute("title")).toBeNull();
  });

  // §19.4 — Rename enabled on files for every provider.
  describe("Rename — file entries", () => {
    const providers: ProviderKind[] = [
      "google-drive",
      "onedrive",
      "s3",
      "mock",
    ];
    for (const provider of providers) {
      it(`${provider} file: Rename enabled, no tooltip`, async () => {
        openMenuFor(provider, makeEntry());
        const rename = await getRenameItem();
        expect(rename.getAttribute("aria-disabled")).not.toBe("true");
        expect(rename.getAttribute("title")).toBeNull();
      });
    }
  });

  // §19.4 — Rename enabled for Drive/OneDrive directories.
  describe("Rename — directory entries on Drive / OneDrive", () => {
    for (const provider of ["google-drive", "onedrive"] as ProviderKind[]) {
      it(`${provider} directory: Rename enabled, no tooltip`, async () => {
        openMenuFor(provider, directoryEntry());
        const rename = await getRenameItem();
        expect(rename.getAttribute("aria-disabled")).not.toBe("true");
        expect(rename.getAttribute("title")).toBeNull();
      });
    }
  });

  // §19.4 — Rename disabled for S3 directories with the new tooltip.
  it("S3 directory: Rename disabled with provider-specific tooltip", async () => {
    openMenuFor("s3", directoryEntry());
    const rename = await getRenameItem();
    expect(rename.getAttribute("aria-disabled")).toBe("true");
    expect(rename.getAttribute("title")).toBe(FILE_TOOLTIP_RENAME_S3);
  });

  // §19.4 — Rename disabled for mock directories with the existing v1
  // tooltip.
  it("Mock directory: Rename disabled with existing v1 tooltip", async () => {
    openMenuFor("mock", directoryEntry());
    const rename = await getRenameItem();
    expect(rename.getAttribute("aria-disabled")).toBe("true");
    expect(rename.getAttribute("title")).toBe(FILE_TOOLTIP_RENAME_MOCK);
  });

  // §19.4 — Download enabled on files for every provider.
  describe("Download — file entries", () => {
    const providers: ProviderKind[] = [
      "google-drive",
      "onedrive",
      "s3",
      "mock",
    ];
    for (const provider of providers) {
      it(`${provider} file: Download enabled, no tooltip`, async () => {
        openMenuFor(provider, makeEntry());
        const download = await getDownloadItem();
        expect(download.getAttribute("aria-disabled")).not.toBe("true");
        expect(download.getAttribute("title")).toBeNull();
      });
    }
  });

  // §19.4 — Download disabled for directories on every provider.
  describe("Download — directory entries (folder download not supported)", () => {
    const providers: ProviderKind[] = [
      "google-drive",
      "onedrive",
      "s3",
      "mock",
    ];
    for (const provider of providers) {
      it(`${provider} directory: Download disabled with v1 tooltip`, async () => {
        openMenuFor(provider, directoryEntry());
        const download = await getDownloadItem();
        expect(download.getAttribute("aria-disabled")).toBe("true");
        expect(download.getAttribute("title")).toBe(
          FILE_TOOLTIP_DOWNLOAD_DIR,
        );
      });
    }
  });
});
