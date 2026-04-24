"use client";

import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";

export interface AuthRevokedStateProps {
  onReconnect: () => void;
}

export function AuthRevokedState({ onReconnect }: AuthRevokedStateProps) {
  return (
    <div
      data-testid="file-explorer-state-auth-revoked"
      role="alert"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[10px] px-4 py-12"
    >
      <Icon
        name="key-round"
        className="text-amber-600"
        width={40}
        height={40}
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <div className="text-[15px] font-semibold text-foreground">
        Sign in again to view files
      </div>
      <div className="max-w-[320px] text-center text-[13px] text-muted-foreground">
        Your session for this datasource expired or was revoked.
      </div>
      <Button
        type="button"
        onClick={onReconnect}
        className="mt-2 bg-amber-600 text-white hover:bg-amber-700"
      >
        Reconnect
      </Button>
    </div>
  );
}
