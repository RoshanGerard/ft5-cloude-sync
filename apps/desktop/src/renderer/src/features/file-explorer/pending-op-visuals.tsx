"use client";

import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

// Shared presentational atoms for pending-op + error visuals across the
// six view modes. Each view mode still owns its own row/cell layout;
// these components only emit the glyph markup so the motion-budget
// whitelist surface is centralised.

export interface PendingOpGlyphProps {
  className?: string;
}

export function PendingOpGlyph({ className }: PendingOpGlyphProps) {
  return (
    <span
      data-testid="explorer-pending-glyph"
      aria-label="Operation in progress"
      role="status"
      className={cn(
        "bg-muted-foreground inline-block size-1.5 shrink-0 animate-sync-pulse",
        className,
      )}
    />
  );
}

export interface ErrorPinProps {
  reason: string;
  className?: string;
}

export function ErrorPin({ reason, className }: ErrorPinProps) {
  return (
    <span
      data-testid="explorer-error-pin"
      title={reason}
      aria-label={reason}
      role="img"
      className={cn("text-destructive inline-flex shrink-0", className)}
    >
      <Icon name="alert-triangle" aria-hidden className="size-3.5" />
    </span>
  );
}
