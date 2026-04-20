import type { FileEntry } from "@ft5/ipc-contracts";

import { formatDate, formatSize, formatType } from "../view-modes/details-format.js";

// design.md Decision 4: Details pane AND Properties modal — two surfaces,
// one shape. The catalog is the single source of truth for both; each
// surface picks which ids to render via `paneFields` / `modalFields`.

export type FieldValue = string | number | null;

export interface FieldDef {
  id: string;
  label: string;
  selector: (entry: FileEntry) => FieldValue;
  // Drives `tabular-nums` on the rendered value. Sizes, timestamps,
  // and other numeric values line up across rows; names and paths do not.
  numeric: boolean;
}

export const fieldCatalog: readonly FieldDef[] = [
  {
    id: "name",
    label: "Name",
    selector: (entry) => entry.name,
    numeric: false,
  },
  {
    id: "path",
    label: "Path",
    selector: (entry) => entry.path,
    numeric: false,
  },
  {
    id: "type",
    label: "Type",
    selector: (entry) => formatType(entry),
    numeric: false,
  },
  {
    id: "size",
    // Directories have `size: null`; the selector returns null so the
    // render layer decides the visual (em-dash) — keeping selectors pure
    // over raw data rather than coupling to display strings.
    label: "Size",
    selector: (entry) => (entry.size === null ? null : formatSize(entry.size)),
    numeric: true,
  },
  {
    id: "modified",
    label: "Modified",
    selector: (entry) => formatDate(entry.modifiedAt),
    numeric: true,
  },
  {
    id: "created",
    label: "Created",
    selector: (entry) =>
      entry.createdAt === null ? null : formatDate(entry.createdAt),
    numeric: true,
  },
];

// Curated subsets — arrays of field ids drawn from `fieldCatalog`.
// Spec scenario "Details pane reflects selection changes" lists the pane
// fields (name, type, size, modified, path). Modal is the full dossier.
export const paneFields: readonly string[] = [
  "name",
  "type",
  "size",
  "modified",
  "path",
];

export const modalFields: readonly string[] = [
  "name",
  "path",
  "type",
  "size",
  "modified",
  "created",
];

export interface ProviderMetadataRow {
  id: string;
  label: string;
  value: string | number | boolean | null;
}

// Pane consumers slice providerMetadataFields to this length; modal
// consumers render all rows. Keeping the number here (rather than in the
// pane component) keeps the two surfaces' rules co-located.
export const PANE_PROVIDER_METADATA_LIMIT = 3;

export function providerMetadataFields(entry: FileEntry): ProviderMetadataRow[] {
  const rows: ProviderMetadataRow[] = [];
  for (const [key, value] of Object.entries(entry.providerMetadata)) {
    rows.push({ id: key, label: humanizeKey(key), value });
  }
  return rows;
}

function humanizeKey(key: string): string {
  if (key.length === 0) return key;
  const withSpaces = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}
