"use client";

//
// OAuth credential form — real consent-broker flow.
//
// Replaces the mocked `delayMs` fake from ui-ux-design with the actual
// `window.api.datasources.startConsent` / `useConsentSession` wiring:
//
//   1. User clicks Connect → `startConsent({providerId, datasourceId?})`.
//   2. Main process opens the system browser at the Google authorization URL.
//   3. Consent events arrive via the datasources event channel into the store.
//   4. Terminal events update the form:
//        - consent-completed → call onSubmit to signal success to the dialog
//        - consent-cancelled / consent-failed / consent-timeout → inline error
//          with Retry button (resets session and calls startConsent again).
//
// Shape: `{ providerId, datasourceId?, onSubmit, onBack }`.
//   - `datasourceId` is present only on the reconnect path (card Reconnect
//     button). Absent on the add-new-datasource path.
//   - `delayMs` prop removed — was only needed for the mocked flow.

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useConsentSession } from "../store";

export interface OAuthFormProps {
  providerId: string;
  providerDisplayName: string;
  /** Present on reconnect path only — omit for add-new-datasource. */
  datasourceId?: string;
  onSubmit: (credentials: Record<string, unknown>) => void;
  onBack: () => void;
}

export function OAuthForm({
  providerId,
  providerDisplayName,
  datasourceId,
  onSubmit,
  onBack,
}: OAuthFormProps) {
  // sessionId is null until startConsent resolves.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const sessionState = useConsentSession(sessionId ?? "__none__");

  // D7 invariant — closing the dialog mid-OAuth must terminate the broker
  // session so completeWith / addToRegistry never run for an abandoned flow.
  // Without this, the broker keeps its loopback HTTP server bound; if the user
  // already clicked Continue in the browser before closing the dialog, the
  // callback still arrives and a registry row materialises in the dashboard
  // for a session the user thought they cancelled.
  //
  // Holds the latest sessionId so the unmount cleanup (with empty deps) sees
  // the live value without re-subscribing every time sessionId changes.
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    return () => {
      const sid = sessionIdRef.current;
      if (sid !== null) {
        // broker.cancel() is idempotent — safe to call after a terminal state.
        void window.api.datasources.cancelConsent({ sessionId: sid });
      }
    };
  }, []);

  const startSession = useCallback(async () => {
    setStarting(true);
    try {
      const req =
        datasourceId !== undefined
          ? { providerId, datasourceId }
          : { providerId };
      const res = await window.api.datasources.startConsent(req);
      setSessionId(res.sessionId);
    } finally {
      setStarting(false);
    }
  }, [providerId, datasourceId]);

  const handleConnect = useCallback(() => {
    void startSession();
  }, [startSession]);

  const handleRetry = useCallback(() => {
    // Reset session so the useConsentSession hook goes back to "pending".
    setSessionId(null);
    void startSession();
  }, [startSession]);

  // Terminal state transitions.
  if (sessionId !== null && sessionState.status === "completed") {
    onSubmit({ _oauthConsent: "completed", datasourceId: sessionState.datasourceId });
  }

  const isWaiting = starting || (sessionId !== null && sessionState.status === "pending");
  const isCancelled = sessionId !== null && sessionState.status === "cancelled";
  const isFailed = sessionId !== null && sessionState.status === "failed";
  const isTimeout = sessionId !== null && sessionState.status === "timeout";
  const hasError = isCancelled || isFailed || isTimeout;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        You&apos;ll be redirected to sign in to {providerDisplayName} and grant
        access. Your browser will open automatically.
      </p>

      {isWaiting && (
        <p
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-sm"
          data-testid="oauth-pending"
        >
          {starting
            ? `Opening ${providerDisplayName} sign-in…`
            : `Waiting for consent in your browser…`}
        </p>
      )}

      {isCancelled && (
        <p
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-sm"
          data-testid="oauth-cancelled"
        >
          Consent cancelled — you can try again.
        </p>
      )}

      {isTimeout && (
        <p
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-sm"
          data-testid="oauth-timeout"
        >
          Consent timed out — please try again.
        </p>
      )}

      {isFailed && (
        <p
          role="status"
          aria-live="polite"
          className="text-destructive text-sm"
          data-testid="oauth-failed"
        >
          {sessionState.message ?? "Authorization failed — please try again."}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onBack}
          disabled={isWaiting}
        >
          Back
        </Button>

        {hasError ? (
          <Button type="button" size="sm" onClick={handleRetry}>
            Retry
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={handleConnect}
            disabled={isWaiting}
          >
            {isWaiting ? "Connecting…" : `Connect ${providerDisplayName}`}
          </Button>
        )}
      </div>
    </div>
  );
}
