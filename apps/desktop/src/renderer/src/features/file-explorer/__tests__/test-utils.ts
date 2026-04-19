import type { FileEntry } from "@ft5/ipc-contracts";

/**
 * Test-only factory for `FileEntry` fixtures. Used by every view-mode test
 * (Details now; List / Small Icons / Tiles / Medium / Large as those tasks
 * land). Override any field via the `overrides` bag.
 *
 * Defaults model a plausible file entry: a 12 KB PNG image at
 * `/project/hero.png`, modified on 2026-04-18. Directory fixtures override
 * `kind` and pass `size: null` per the contract.
 */
export function seedEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  const base: FileEntry = {
    id: "entry-1",
    kind: "file",
    name: "hero.png",
    path: "/project/hero.png",
    parentPath: "/project",
    size: 12_288,
    mimeFamily: "image",
    mimeType: "image/png",
    modifiedAt: "2026-04-18T10:30:00.000Z",
    createdAt: null,
    providerMetadata: {},
  };
  return { ...base, ...overrides };
}
