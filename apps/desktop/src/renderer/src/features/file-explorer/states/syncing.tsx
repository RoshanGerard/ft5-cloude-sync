"use client";

import { Icon } from "@/components/icon";

export interface SyncingStateProps {
  /**
   * Optional progress copy (e.g. "~1,240 files · 32%"). Rendered in
   * `text-blue-600` below the body copy. When omitted the component
   * shows only the spinner / headline / body — the progress line is
   * hidden entirely.
   */
  progressLabel?: string;
}

export function SyncingState({ progressLabel }: SyncingStateProps) {
  return (
    <div
      data-testid="file-explorer-state-syncing"
      role="status"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[10px] px-4 py-12"
    >
      <Icon
        name="refresh-cw"
        className="animate-spin text-blue-600"
        width={40}
        height={40}
        strokeWidth={1.5}
        aria-hidden="true"
        style={{ animationDuration: "2.4s", animationTimingFunction: "linear" }}
      />
      <div className="text-[15px] font-semibold text-foreground">
        Indexing your files…
      </div>
      <div className="max-w-[320px] text-center text-[13px] text-muted-foreground">
        This happens once on first connect. Files will appear as they&apos;re
        discovered.
      </div>
      {progressLabel !== undefined && progressLabel.length > 0 ? (
        <div className="mt-1 text-[12px] text-blue-600">{progressLabel}</div>
      ) : null}
    </div>
  );
}
