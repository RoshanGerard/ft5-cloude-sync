"use client";

import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";

export interface DisconnectedStateProps {
  onRetry: () => void;
}

/**
 * Pattern-A full-replace state rendered when `files:list` rejects with
 * envelope tag `"disconnected"`. Amber iconography + primary action —
 * signals "you need to act" per the approved visual direction in
 * design.md § Visual direction.
 */
export function DisconnectedState({ onRetry }: DisconnectedStateProps) {
  return (
    <div
      data-testid="file-explorer-state-disconnected"
      role="alert"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[10px] px-4 py-12"
    >
      <Icon
        name="cloud-off"
        className="text-amber-600"
        width={40}
        height={40}
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <div className="text-[15px] font-semibold text-foreground">
        Can&apos;t reach this datasource
      </div>
      <div className="max-w-[320px] text-center text-[13px] text-muted-foreground">
        Check your network or try again in a moment.
      </div>
      <Button
        type="button"
        onClick={onRetry}
        className="mt-2 bg-amber-600 text-white hover:bg-amber-700"
      >
        Retry
      </Button>
    </div>
  );
}
