import type { FileEntry, MimeFamily } from "@ft5/ipc-contracts";

import type { IconName } from "../../components/icon";

// Per design.md Decision 8. Central mapping; no extension parsing in the
// renderer — mimeFamily is normalized in the handler (see Decision 2).
// The renderer asks `iconForEntry(entry)` and gets back an `IconName` the
// `Icon` adapter knows how to render. Adding a new family is a one-line
// edit here plus a row in the adapter's registry.
const FAMILY_TO_ICON: Record<MimeFamily, IconName> = {
  image: "file-image",
  video: "file-video",
  audio: "file-audio",
  // `document` reuses `file-text` until we wire a more specific lucide glyph
  // (e.g. file-type-pdf / file-type-doc). Flagged in Decision 8's mapping
  // table as "or file-type variants when we add more specificity later".
  document: "file-text",
  archive: "file-archive",
  code: "file-code",
  text: "file-text",
  unknown: "file",
};

/**
 * Pure function: (kind, mimeFamily) → IconName.
 *
 * Directory entries always resolve to `folder` regardless of mimeFamily —
 * kind wins. File entries route through the FAMILY_TO_ICON table. Same
 * input yields the same output, no side effects, no string parsing.
 */
export function iconForEntry(
  entry: Pick<FileEntry, "kind" | "mimeFamily">,
): IconName {
  if (entry.kind === "directory") return "folder";
  return FAMILY_TO_ICON[entry.mimeFamily];
}
