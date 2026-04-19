import type { FileEntry } from "@ft5/ipc-contracts";

/**
 * Shared cell formatters for the file-explorer view modes. Extracted so
 * Details (now) and the five other view modes (as those land) render
 * the same numeric / date text without redefining the rules.
 *
 * Display conventions:
 *   - Size:     binary units shown as B / KB / MB / GB, `\u2014` (em-dash)
 *               for `size === null` (directories). One decimal under 10,
 *               zero decimals at 10 and above.
 *   - Date:     en-US short, no time — e.g. "Apr 18, 2026".
 *   - MimeType: capitalise the `mimeFamily` label ("image" → "Image")
 *               so users see familiar "type" column values.
 */

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function formatSize(bytes: number | null): string {
  if (bytes === null) return "\u2014";
  if (bytes === 0) return "0 B";

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value = value / 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value);
  return `${formatted} ${SIZE_UNITS[unit]}`;
}

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return DATE_FORMATTER.format(d);
}

export function formatType(entry: Pick<FileEntry, "kind" | "mimeFamily">): string {
  if (entry.kind === "directory") return "Folder";
  const f = entry.mimeFamily;
  return f.charAt(0).toUpperCase() + f.slice(1);
}
