"use client";

import { Icon } from "@/components/icon";

/**
 * Pattern-A full-replace state rendered when the datasource is
 * connected (or paused) and the current folder resolves to zero
 * entries. Neutral iconography, no action button — the user's next
 * move is to drop files via another surface.
 */
export function EmptyState() {
  return (
    <div
      data-testid="file-explorer-state-empty"
      role="status"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[10px] px-4 py-12"
    >
      <Icon
        name="folder-open"
        className="text-muted-foreground"
        width={40}
        height={40}
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <div className="text-[15px] font-semibold text-foreground">
        This folder is empty
      </div>
      <div className="max-w-[320px] text-center text-[13px] text-muted-foreground">
        Drop files on your datasource or upload from the sync service —
        they&apos;ll appear here.
      </div>
    </div>
  );
}
