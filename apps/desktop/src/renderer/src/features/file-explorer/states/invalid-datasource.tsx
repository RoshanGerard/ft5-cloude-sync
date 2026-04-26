"use client";

//
// add-invalid-datasource-state §7 — file-explorer Pattern-A full-replace
// state for a misconfigured datasource (registry drift / missing credentials
// / wrong-shape credential JSON). Mirrors the visual scaffolding of
// `auth-revoked.tsx` and the consent-session lifecycle of `AuthErrorBanner`
// in `features/datasources/card.tsx`.
//
// Per design.md Decision 3 + Decision 4, this component owns its own
// `startConsent` call inline (not delegated to the parent) so the spinner /
// disabled-state rendering co-locates with the lifecycle subscription. The
// parent wires `onReconnectSucceeded` to `store.retryLoad()` so the
// explorer's `useExplorerData` re-dispatches `files:list` once consent
// completes, and the component naturally transitions out of this arm.
//
// Per design.md Decision 6, the Reconnect button uses the neutral
// `bg-primary` styling (constructive default) — the red sentiment is carried
// by the 40px AlertTriangle icon (`text-destructive`) at the top, NOT by
// the Reconnect button.
//

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";
import { useConsentSession } from "@/features/datasources/store";

export interface InvalidDatasourceStateProps {
  /**
   * The provider key (`google-drive`, `onedrive`, `amazon-s3`, ...) needed
   * to construct the `startConsent` request. Threaded from the route layer
   * via `summary.providerId`. When undefined (test renders the component in
   * isolation), the Reconnect button is disabled with `aria-disabled="true"`
   * and a tooltip explaining the missing context.
   */
  providerId?: string;
  /** The datasource whose credentials need re-registering. */
  datasourceId: string;
  /**
   * Invoked exactly once after the consent session reaches
   * `status === "completed"`. Parent wires this to
   * `useFileExplorerStore().retryLoad()` so the explorer re-dispatches
   * `files:list` and the engine resolves the freshly-registered credential.
   */
  onReconnectSucceeded: () => void;
  /**
   * Invoked when the user clicks "Remove datasource". Parent owns the
   * shared `<ConfirmRemoveDatasourceDialog>` instance per Decision 5; this
   * component is purely the trigger.
   */
  onRequestRemove: () => void;
}

export function InvalidDatasourceState({
  providerId,
  datasourceId,
  onReconnectSucceeded,
  onRequestRemove,
}: InvalidDatasourceStateProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Pass a sentinel when no session is active so the hook always returns
  // a well-defined `{ status: "pending" }` for the unused slot, matching
  // the `AuthErrorBanner` pattern in `card.tsx:285`.
  const sessionState = useConsentSession(sessionId ?? "__none__");

  const isWaiting =
    sessionId !== null && sessionState.status === "pending";
  const isFailed =
    sessionId !== null &&
    (sessionState.status === "cancelled" ||
      sessionState.status === "failed" ||
      sessionState.status === "timeout");

  // Single-fire guard: even if the parent does not immediately remount us
  // when `onReconnectSucceeded` triggers `store.retryLoad()`, multiple
  // re-renders with the same `completed` state must not fire the callback
  // twice. A ref-tracked sessionId is the simplest barrier — once we've
  // notified for a given sessionId, we don't notify again.
  const succeededFiredFor = useRef<string | null>(null);
  useEffect(() => {
    if (sessionId === null) return;
    if (sessionState.status !== "completed") return;
    if (succeededFiredFor.current === sessionId) return;
    succeededFiredFor.current = sessionId;
    onReconnectSucceeded();
  }, [sessionId, sessionState, onReconnectSucceeded]);

  const handleReconnect = useCallback(async () => {
    if (providerId === undefined) return;
    if (isWaiting) return;
    const res = await window.api.datasources.startConsent({
      providerId,
      datasourceId,
    });
    setSessionId(res.sessionId);
  }, [providerId, datasourceId, isWaiting]);

  const reconnectDisabled = providerId === undefined;
  const reconnectLabel = isWaiting ? "Connecting…" : "Reconnect";

  return (
    <div
      data-testid="file-explorer-state-invalid-datasource"
      role="alert"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[10px] px-4 py-12"
    >
      <Icon
        name="alert-triangle"
        className="text-destructive"
        width={40}
        height={40}
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <div className="text-[15px] font-semibold text-foreground">
        This datasource needs reconfiguring
      </div>
      <div className="max-w-[320px] text-center text-[13px] text-muted-foreground">
        Its connection details are missing or invalid. Sign in again or remove
        the datasource and add it back.
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          // When `providerId` is missing we keep the button focusable but
          // mark it as `aria-disabled` per the spec — the tooltip explains
          // the cause. We do NOT use the native `disabled` attribute here
          // because that would remove it from the AT tree entirely; the
          // user clicking still must be a no-op (the click handler
          // short-circuits when `providerId === undefined`).
          aria-disabled={reconnectDisabled || undefined}
          title={
            reconnectDisabled
              ? "Provider information unavailable — return to the dashboard to reconnect"
              : undefined
          }
          // For waiting state we DO disable natively so screen readers
          // announce the busy-state and click does not re-trigger.
          disabled={isWaiting}
          onClick={() => {
            void handleReconnect();
          }}
        >
          {isWaiting ? (
            <Icon
              name="loader-2"
              data-testid="invalid-datasource-spinner"
              className="size-4 animate-spin"
              aria-hidden="true"
            />
          ) : null}
          {reconnectLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive"
          disabled={isWaiting}
          onClick={onRequestRemove}
        >
          Remove datasource
        </Button>
      </div>
      {isFailed ? (
        <p className="text-[12px] text-destructive">
          Reconnect failed — please try again.
        </p>
      ) : null}
    </div>
  );
}
