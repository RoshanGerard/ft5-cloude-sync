// Maps the engine's `DatasourceFileEntry<T>` (used by listDirectory,
// search, getMetadata) into the renderer-facing `FileEntry` shape that
// travels through the `files:*` IPC envelope. The two shapes diverge on:
//
//   - kind: engine uses "file" | "folder"; UI uses "file" | "directory"
//   - size: engine has optional `number`; UI has `number | null`
//   - modifiedAt: engine has epoch ms; UI has ISO string
//   - createdAt + parentPath + mimeType + id: not present in the engine
//     shape; derived or defaulted here
//   - mimeFamily: engine vocab includes "folder" / "other"; UI vocab has
//     "text" / "unknown" and no "folder" (that's encoded as kind)

import { posix as posixPath } from "node:path";

import type {
  DatasourceFileEntry,
  DatasourceMimeFamily,
  DatasourceType,
  FileEntry,
  MimeFamily,
} from "@ft5/ipc-contracts";

function mapMimeFamily(
  source: DatasourceMimeFamily,
  kind: "file" | "folder",
): MimeFamily {
  if (kind === "folder") return "unknown";
  switch (source) {
    case "image":
    case "video":
    case "audio":
    case "document":
    case "archive":
    case "code":
      return source;
    case "folder":
      // Unreachable in the kind==="file" branch; safe fallback.
      return "unknown";
    case "other":
    default:
      return "unknown";
  }
}

function parentPathOf(path: string): string {
  if (path === "/" || path === "") return "/";
  const parent = posixPath.dirname(path);
  return parent === "" ? "/" : parent;
}

function flattenProviderMetadata(
  meta: unknown,
): Record<string, string | number | boolean | null> {
  if (meta === null || typeof meta !== "object") return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v;
    }
    // Non-primitive values (arrays, nested objects) are dropped: the UI
    // surface only advertises primitives in ProviderMetadata. Preserving
    // them would force `unknown` on the renderer consumer.
  }
  return out;
}

export function mapEngineEntryToFileEntry<T extends DatasourceType>(
  entry: DatasourceFileEntry<T>,
): FileEntry {
  return {
    // `handle` is the engine's stable addressable id per provider; it's
    // the right thing to thread into the UI's `id` slot.
    id: entry.handle,
    kind: entry.kind === "folder" ? "directory" : "file",
    name: entry.name,
    path: entry.path,
    parentPath: parentPathOf(entry.path),
    size: entry.size ?? null,
    mimeFamily: mapMimeFamily(entry.mimeFamily, entry.kind),
    mimeType: null,
    modifiedAt: new Date(entry.modifiedAt).toISOString(),
    createdAt: null,
    providerMetadata: flattenProviderMetadata(entry.providerMetadata),
  };
}
