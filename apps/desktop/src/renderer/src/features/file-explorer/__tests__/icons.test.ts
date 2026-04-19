import { describe, expect, it } from "vitest";

import type { FileEntry } from "@ft5/ipc-contracts";

import { iconForEntry } from "../icons.js";

// Every case below is one row of design.md Decision 8's (kind, mimeFamily)
// → lucide icon mapping. `directory` always wins: kind trumps mimeFamily.
// File entries fall through to the MimeFamily → IconName table. Unknown
// mime families render the generic `file` glyph.

describe("iconForEntry — design.md Decision 8 mapping", () => {
  it("renders `folder` for a directory with mimeFamily=unknown", () => {
    expect(
      iconForEntry({ kind: "directory", mimeFamily: "unknown" }),
    ).toBe("folder");
  });

  it("renders `folder` for a directory even when mimeFamily is a file family (kind wins)", () => {
    expect(
      iconForEntry({ kind: "directory", mimeFamily: "image" }),
    ).toBe("folder");
  });

  it("renders `file-image` for a file with mimeFamily=image", () => {
    expect(
      iconForEntry({ kind: "file", mimeFamily: "image" }),
    ).toBe("file-image");
  });

  it("renders `file-video` for a file with mimeFamily=video", () => {
    expect(
      iconForEntry({ kind: "file", mimeFamily: "video" }),
    ).toBe("file-video");
  });

  it("renders `file-audio` for a file with mimeFamily=audio", () => {
    expect(
      iconForEntry({ kind: "file", mimeFamily: "audio" }),
    ).toBe("file-audio");
  });

  it("renders `file-text` for a file with mimeFamily=document", () => {
    expect(
      iconForEntry({ kind: "file", mimeFamily: "document" }),
    ).toBe("file-text");
  });

  it("renders `file-archive` for a file with mimeFamily=archive", () => {
    expect(
      iconForEntry({ kind: "file", mimeFamily: "archive" }),
    ).toBe("file-archive");
  });

  it("renders `file-code` for a file with mimeFamily=code", () => {
    expect(
      iconForEntry({ kind: "file", mimeFamily: "code" }),
    ).toBe("file-code");
  });

  it("renders `file-text` for a file with mimeFamily=text", () => {
    expect(
      iconForEntry({ kind: "file", mimeFamily: "text" }),
    ).toBe("file-text");
  });

  it("renders `file` for a file with mimeFamily=unknown", () => {
    expect(
      iconForEntry({ kind: "file", mimeFamily: "unknown" }),
    ).toBe("file");
  });
});

describe("iconForEntry — purity", () => {
  it("is pure: same input → same output, no side effects across calls", () => {
    // A representative entry shape `iconForEntry` might see from the store.
    const entry: Pick<FileEntry, "kind" | "mimeFamily"> = {
      kind: "file",
      mimeFamily: "image",
    };
    const first = iconForEntry(entry);
    const second = iconForEntry(entry);
    expect(first).toBe(second);
    // Also sanity-check a different input is deterministic.
    const dirFirst = iconForEntry({ kind: "directory", mimeFamily: "code" });
    const dirSecond = iconForEntry({ kind: "directory", mimeFamily: "code" });
    expect(dirFirst).toBe(dirSecond);
    expect(dirFirst).toBe("folder");
  });
});
