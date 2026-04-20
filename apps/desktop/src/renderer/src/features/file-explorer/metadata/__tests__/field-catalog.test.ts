import { describe, expect, it } from "vitest";

import type { FileEntry } from "@ft5/ipc-contracts";

import {
  fieldCatalog,
  modalFields,
  paneFields,
  providerMetadataFields,
  PANE_PROVIDER_METADATA_LIMIT,
  type FieldDef,
} from "../field-catalog.js";
import { seedEntry } from "../../__tests__/test-utils.js";

// Design.md Decision 4: Details pane AND Properties modal — two surfaces,
// one shape. The catalog is the single source of truth for both.
//
// Spec scenario "Details pane reflects selection changes" lists the pane
// fields: name, type, size, modified, path. The modal adds `created` and
// the complete provider-metadata dossier.

const REQUIRED_CATALOG_IDS = [
  "name",
  "path",
  "type",
  "size",
  "modified",
  "created",
] as const;

function findField(id: string): FieldDef {
  const f = fieldCatalog.find((x) => x.id === id);
  if (f === undefined) throw new Error(`missing field ${id}`);
  return f;
}

describe("fieldCatalog — shape", () => {
  it("exports every required field id", () => {
    const ids = fieldCatalog.map((f) => f.id);
    for (const required of REQUIRED_CATALOG_IDS) {
      expect(ids).toContain(required);
    }
  });

  it("every field has id, label, and selector", () => {
    for (const field of fieldCatalog) {
      expect(typeof field.id).toBe("string");
      expect(field.id.length).toBeGreaterThan(0);
      expect(typeof field.label).toBe("string");
      expect(field.label.length).toBeGreaterThan(0);
      expect(typeof field.selector).toBe("function");
    }
  });

  it("field ids are unique", () => {
    const ids = fieldCatalog.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("fieldCatalog — selectors (pure, null-safe)", () => {
  it("name selector returns entry.name", () => {
    const entry = seedEntry({ name: "report.pdf" });
    expect(findField("name").selector(entry)).toBe("report.pdf");
  });

  it("path selector returns entry.path", () => {
    const entry = seedEntry({ path: "/docs/report.pdf" });
    expect(findField("path").selector(entry)).toBe("/docs/report.pdf");
  });

  it("type selector returns the formatted mime family for files", () => {
    const entry = seedEntry({ kind: "file", mimeFamily: "image" });
    // Matches formatType in view-modes/details-format.ts ("image" → "Image").
    expect(findField("type").selector(entry)).toBe("Image");
  });

  it("type selector returns 'Folder' for directory entries", () => {
    const entry = seedEntry({ kind: "directory", size: null });
    expect(findField("type").selector(entry)).toBe("Folder");
  });

  it("size selector returns a formatted human size for files", () => {
    const entry = seedEntry({ size: 12_288 });
    // Matches formatSize in view-modes/details-format.ts — "12 KB".
    expect(findField("size").selector(entry)).toBe("12 KB");
  });

  it("size selector returns null for directories (size=null)", () => {
    const entry = seedEntry({ kind: "directory", size: null });
    expect(findField("size").selector(entry)).toBeNull();
  });

  it("modified selector returns a formatted date", () => {
    const entry = seedEntry({ modifiedAt: "2026-04-18T10:30:00.000Z" });
    // Matches formatDate — "Apr 18, 2026".
    expect(findField("modified").selector(entry)).toBe("Apr 18, 2026");
  });

  it("created selector returns a formatted date when present", () => {
    const entry = seedEntry({ createdAt: "2026-01-05T00:00:00.000Z" });
    expect(findField("created").selector(entry)).toBe("Jan 5, 2026");
  });

  it("created selector returns null when createdAt is null", () => {
    const entry = seedEntry({ createdAt: null });
    expect(findField("created").selector(entry)).toBeNull();
  });

  it("selectors are pure — same input returns same output across calls", () => {
    const entry = seedEntry();
    for (const field of fieldCatalog) {
      const a = field.selector(entry);
      const b = field.selector(entry);
      expect(a).toStrictEqual(b);
    }
  });
});

describe("fieldCatalog — numeric flag (drives tabular-nums)", () => {
  it("size and modified and created are flagged numeric", () => {
    expect(findField("size").numeric).toBe(true);
    expect(findField("modified").numeric).toBe(true);
    expect(findField("created").numeric).toBe(true);
  });

  it("name and path and type are NOT flagged numeric", () => {
    expect(findField("name").numeric).toBe(false);
    expect(findField("path").numeric).toBe(false);
    expect(findField("type").numeric).toBe(false);
  });
});

describe("paneFields / modalFields — curated subsets", () => {
  it("paneFields and modalFields are arrays of ids present in the catalog", () => {
    const catalogIds = new Set(fieldCatalog.map((f) => f.id));
    for (const id of paneFields) expect(catalogIds.has(id)).toBe(true);
    for (const id of modalFields) expect(catalogIds.has(id)).toBe(true);
  });

  it("paneFields covers the spec's pane-scenario fields", () => {
    // Spec: "pane shows that entry's name, type, size, modified timestamp,
    // path, and any available provider-metadata fields…".
    for (const id of ["name", "type", "size", "modified", "path"]) {
      expect(paneFields).toContain(id);
    }
  });

  it("paneFields is a strict subset of modalFields", () => {
    const modalSet = new Set(modalFields);
    for (const id of paneFields) expect(modalSet.has(id)).toBe(true);
    // Strict: modal has at least one id pane does not.
    const paneSet = new Set(paneFields);
    const extras = modalFields.filter((id) => !paneSet.has(id));
    expect(extras.length).toBeGreaterThan(0);
  });

  it("modalFields includes `created` (the full dossier differentiator)", () => {
    expect(modalFields).toContain("created");
  });

  it("paneFields does NOT include `created` (kept compact)", () => {
    expect(paneFields).not.toContain("created");
  });
});

describe("providerMetadataFields", () => {
  it("returns an empty list when providerMetadata is empty", () => {
    const entry = seedEntry({ providerMetadata: {} });
    expect(providerMetadataFields(entry)).toEqual([]);
  });

  it("turns each providerMetadata key into a row with id/label/value", () => {
    const entry = seedEntry({
      providerMetadata: {
        ownerEmail: "alice@example.com",
        storageClass: "STANDARD",
        encrypted: true,
        revisionCount: 7,
      },
    });
    const rows = providerMetadataFields(entry);
    expect(rows.length).toBe(4);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.ownerEmail).toBeDefined();
    expect(byId.ownerEmail!.value).toBe("alice@example.com");
    expect(byId.storageClass!.value).toBe("STANDARD");
    expect(byId.encrypted!.value).toBe(true);
    expect(byId.revisionCount!.value).toBe(7);
  });

  it("passes through null values without collapsing the row", () => {
    const entry = seedEntry({
      providerMetadata: { lockReason: null },
    });
    const rows = providerMetadataFields(entry);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("lockReason");
    expect(rows[0]!.value).toBeNull();
  });

  it("produces a human-ish label derived from the key", () => {
    const entry = seedEntry({
      providerMetadata: { ownerEmail: "a@b.test", storageClass: "STANDARD" },
    });
    const rows = providerMetadataFields(entry);
    const owner = rows.find((r) => r.id === "ownerEmail")!;
    const storage = rows.find((r) => r.id === "storageClass")!;
    // Labels are non-empty, distinct from the raw id, and not the untouched
    // camelCase key. The exact casing is an implementation choice but at
    // minimum it splits camelCase / starts capitalized.
    expect(owner.label.length).toBeGreaterThan(0);
    expect(storage.label.length).toBeGreaterThan(0);
    expect(owner.label).not.toBe("ownerEmail");
    expect(storage.label).not.toBe("storageClass");
    expect(/[A-Z]/.test(owner.label[0]!)).toBe(true);
  });

  it("exports a PANE_PROVIDER_METADATA_LIMIT constant of 3", () => {
    // Pane consumers slice with this constant; modal consumers do not slice.
    // Keeping the number in the metadata module keeps the pane/modal decisions
    // co-located (design.md Decision 4).
    expect(PANE_PROVIDER_METADATA_LIMIT).toBe(3);
  });

  it("preserves insertion order of providerMetadata keys", () => {
    const entry = seedEntry({
      providerMetadata: { a: 1, b: 2, c: 3, d: 4 },
    });
    const rows = providerMetadataFields(entry);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("providerMetadataFields — row shape matches FileEntry.providerMetadata value type", () => {
  it("supports string, number, boolean, null values end-to-end", () => {
    const entry: FileEntry = seedEntry({
      providerMetadata: {
        s: "str",
        n: 42,
        b: false,
        z: null,
      },
    });
    const rows = providerMetadataFields(entry);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.value]));
    expect(byId.s).toBe("str");
    expect(byId.n).toBe(42);
    expect(byId.b).toBe(false);
    expect(byId.z).toBeNull();
  });
});

describe("fieldCatalog — rawSelector (clipboard payload for modal copy affordance)", () => {
  it("name rawSelector returns entry.name", () => {
    const entry = seedEntry({ name: "report.pdf" });
    expect(findField("name").rawSelector?.(entry)).toBe("report.pdf");
  });

  it("path rawSelector returns entry.path", () => {
    const entry = seedEntry({ path: "/docs/report.pdf" });
    expect(findField("path").rawSelector?.(entry)).toBe("/docs/report.pdf");
  });

  it("type rawSelector returns mimeType when present", () => {
    const entry = seedEntry({ mimeType: "image/png", mimeFamily: "image" });
    expect(findField("type").rawSelector?.(entry)).toBe("image/png");
  });

  it("type rawSelector falls back to mimeFamily when mimeType is missing", () => {
    const entry = seedEntry({ mimeType: undefined, mimeFamily: "archive" });
    expect(findField("type").rawSelector?.(entry)).toBe("archive");
  });

  it("size rawSelector returns entry.size (raw bytes) for files", () => {
    const entry = seedEntry({ size: 12_288 });
    expect(findField("size").rawSelector?.(entry)).toBe(12_288);
  });

  it("size rawSelector returns null for directories", () => {
    const entry = seedEntry({ kind: "directory", size: null });
    expect(findField("size").rawSelector?.(entry)).toBeNull();
  });

  it("modified rawSelector returns the raw ISO string", () => {
    const entry = seedEntry({ modifiedAt: "2026-04-18T10:30:00.000Z" });
    expect(findField("modified").rawSelector?.(entry)).toBe(
      "2026-04-18T10:30:00.000Z",
    );
  });

  it("created rawSelector returns the raw ISO string when present", () => {
    const entry = seedEntry({ createdAt: "2026-01-05T00:00:00.000Z" });
    expect(findField("created").rawSelector?.(entry)).toBe(
      "2026-01-05T00:00:00.000Z",
    );
  });

  it("created rawSelector returns null when createdAt is null", () => {
    const entry = seedEntry({ createdAt: null });
    expect(findField("created").rawSelector?.(entry)).toBeNull();
  });
});

describe("humanizeKey handles underscore and kebab and UPPER_SNAKE keys", () => {
  it("converts snake_case to space-separated and capitalizes first char", () => {
    const entry = seedEntry({ providerMetadata: { owner_email: "x@y" } });
    const rows = providerMetadataFields(entry);
    expect(rows[0]!.label).toBe("Owner email");
  });

  it("converts kebab-case to space-separated and capitalizes first char", () => {
    const entry = seedEntry({ providerMetadata: { "storage-class": "STANDARD" } });
    const rows = providerMetadataFields(entry);
    expect(rows[0]!.label).toBe("Storage class");
  });

  it("leaves trailing UPPER chars untouched (UPPER_SNAKE → UPPER SNAKE)", () => {
    const entry = seedEntry({ providerMetadata: { UPPER_SNAKE: "x" } });
    const rows = providerMetadataFields(entry);
    expect(rows[0]!.label).toBe("UPPER SNAKE");
  });
});
