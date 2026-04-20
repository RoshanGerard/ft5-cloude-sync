"use client";

import { useSyncExternalStore } from "react";

import { Icon } from "@/components/icon";

import type { ExplorerStore } from "./store";

/**
 * Breadcrumb — keyboard-navigable path trail for the file explorer.
 *
 * Reads `currentPath` from the passed-in `ExplorerStore` via
 * `useSyncExternalStore` (mirrors the theme-store hook pattern). Prior
 * segments render as native <button> elements that dispatch
 * `store.navigate(path)`; the final segment is the current-location label
 * (non-interactive, `aria-current="page"`).
 *
 * Design divergence from the spec text: the spec scenario reads "separated
 * by `›` chevrons at `text-muted-foreground`"; we use the lucide
 * `chevron-right` icon via the central `Icon` adapter for visual
 * consistency with the rest of the app. Design.md Decision 9 uses `›` as a
 * glyph approximation; both readings converge on a right-pointing chevron
 * at muted-foreground colour. Flagged in the feature's task report.
 */

export interface BreadcrumbProps {
  store: ExplorerStore;
}

interface Segment {
  name: string;
  path: string;
}

function segmentsFor(currentPath: string): Segment[] {
  const parts = currentPath.split("/").filter((p) => p.length > 0);
  const out: Segment[] = [{ name: "root", path: "/" }];
  for (let i = 0; i < parts.length; i += 1) {
    const name = parts[i];
    if (typeof name !== "string") continue;
    const path = "/" + parts.slice(0, i + 1).join("/");
    out.push({ name, path });
  }
  return out;
}

export function Breadcrumb({ store }: BreadcrumbProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const segments = segmentsFor(state.currentPath);

  return (
    <nav aria-label="Folder path" className="flex min-w-0 items-center">
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {segments.map((seg, i) => {
          const isLast = i === segments.length - 1;
          const label = seg.name;
          return (
            <li key={seg.path} className="flex items-center gap-1">
              {i > 0 ? (
                <Icon
                  name="chevron-right"
                  className="size-3 text-muted-foreground"
                  aria-hidden
                />
              ) : null}
              {isLast ? (
                <span
                  aria-current="page"
                  className="text-foreground truncate px-1"
                >
                  {label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    store.navigate(seg.path);
                  }}
                  className="text-muted-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 truncate rounded-md px-1 outline-none transition-colors focus-visible:ring-[3px]"
                >
                  {label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
