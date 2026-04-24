"use client";

import type { ViewMode } from "../store";

export interface SkeletonProps {
  mode: ViewMode;
}

const SHIMMER = "bg-muted/70";
const ROW_COUNT = 6;

/**
 * Pattern-matching loading skeleton. Renders 6 greyed placeholder rows
 * whose silhouette mirrors the active view mode (list / details: icon
 * rect + name rect + trailing metadata; small-icons / tiles: icon rect
 * + stacked text rects; medium-icons / large-icons: square image rect
 * + name rect below). No spinner, no "Loading…" text — the shape
 * itself communicates "content is arriving".
 */
export function Skeleton({ mode }: SkeletonProps) {
  const rows = Array.from({ length: ROW_COUNT }, (_, i) => i);
  if (mode === "medium" || mode === "large") {
    const size = mode === "large" ? 88 : 64;
    return (
      <div
        data-testid="file-explorer-skeleton"
        data-mode={mode}
        aria-hidden="true"
        className="grid gap-4 p-4"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${size + 32}px, 1fr))`,
        }}
      >
        {rows.map((i) => (
          <div key={i} className="flex flex-col items-center gap-2">
            <div
              className={`rounded ${SHIMMER}`}
              style={{ width: size, height: size }}
            />
            <div className={`h-[10px] w-[70%] rounded ${SHIMMER}`} />
          </div>
        ))}
      </div>
    );
  }
  if (mode === "small" || mode === "tiles") {
    return (
      <div
        data-testid="file-explorer-skeleton"
        data-mode={mode}
        aria-hidden="true"
        className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2 p-4"
      >
        {rows.map((i) => (
          <div key={i} className="flex items-center gap-2">
            <div className={`h-5 w-5 rounded ${SHIMMER}`} />
            <div className="flex flex-1 flex-col gap-1">
              <div className={`h-[10px] w-[80%] rounded ${SHIMMER}`} />
              <div className={`h-[8px] w-[50%] rounded ${SHIMMER}`} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  // list + details share the same row silhouette.
  return (
    <div
      data-testid="file-explorer-skeleton"
      data-mode={mode}
      aria-hidden="true"
      className="px-4 py-2"
    >
      {rows.map((i) => (
        <div
          key={i}
          className="flex items-center gap-[10px] py-[8px]"
        >
          <div className={`h-[14px] w-[14px] rounded ${SHIMMER}`} />
          <div
            className={`h-[10px] rounded ${SHIMMER}`}
            style={{ width: 120 + ((i * 37) % 120) }}
          />
          <div className="flex-1" />
          <div className={`h-[10px] w-[50px] rounded ${SHIMMER}`} />
        </div>
      ))}
    </div>
  );
}
