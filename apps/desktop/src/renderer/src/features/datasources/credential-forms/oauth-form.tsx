"use client";

//
// OAuth credential form — implement-datasource-onboarding §22.
//
// Drives the service-side authenticate flow:
//
//   1. User clicks Connect → window.api.sync.authenticateStart({providerId,
//      datasourceId?}) returns { ok: true, result: { correlationId,
//      kind: "oauth" } } or { ok: false, error: SyncAuthenticateStartError }.
//   2. The desktop main's sync event-bridge intercepts the service-emitted
//      `oauth-open-url` event and calls shell.openExternal(authorizeUrl).
//      The renderer is URL-blind — it never sees the authorize URL.
//   3. Auth lifecycle events arrive on window.api.sync.onEvent and the
//      `useAuthSession(correlationId)` hook surfaces the per-correlation
//      state to this component.
//   4. Terminal events update the form:
//        - auth-completed → onSubmit({_authCompleted: "completed",
//          datasourceId}) so the parent dialog refreshes + closes.
//        - auth-cancelled / auth-failed / auth-timeout → inline copy with a
//          Retry button that re-invokes authenticateStart with the same
//          providerId.
//
// `service-config-missing` arrives via the start-call's response envelope
// (`{ok: false, error: {tag: "service-config-missing", path}}`) NOT via an
// auth-failed event — the failure is a typed error class per design.md
// Decision 7. The form renders inline copy with `<code>{path}</code>` and
// a README pointer; Retry is available but will surface the same error
// until the user fixes the file.

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAuthSession } from "../store";

export interface OAuthFormProps {
  providerId: string;
  providerDisplayName: string;
  /** Present on reconnect path only — omit for add-new-datasource. */
  datasourceId?: string;
  onSubmit: (credentials: Record<string, unknown>) => void;
  onBack: () => void;
}

interface ConfigMissingError {
  readonly tag: "service-config-missing";
  readonly path: string;
}

export function OAuthForm({
  providerId,
  providerDisplayName,
  datasourceId,
  onSubmit,
  onBack,
}: OAuthFormProps) {
  // correlationId is null until authenticateStart resolves with ok: true.
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Set when authenticateStart's response is `{ ok: false, error }` — the
  // typed error class for `service-config-missing` is surfaced inline as
  // its own failed-state branch alongside auth-failed events.
  const [configMissing, setConfigMissing] = useState<ConfigMissingError | null>(
    null,
  );
  // Capture a non-config-missing error on the start path so the user gets
  // some inline feedback (engine-error / unknown-provider) when the start
  // call rejects before any event fires.
  const [startError, setStartError] = useState<string | null>(null);

  const sessionState = useAuthSession(correlationId ?? "__none__");

  // Closing the dialog mid-authentication MUST terminate the service-side
  // session so the loopback HTTP server tears down and the broker does not
  // resolve a callback for an abandoned flow.
  //
  // Holds the latest correlationId so the unmount cleanup (with empty deps)
  // sees the live value without re-subscribing every time correlationId
  // changes.
  const correlationIdRef = useRef<string | null>(null);
  useEffect(() => {
    correlationIdRef.current = correlationId;
  }, [correlationId]);
  useEffect(() => {
    return () => {
      const cid = correlationIdRef.current;
      if (cid !== null) {
        // service.authenticateCancel is idempotent — safe to call after a
        // terminal state.
        void window.api.sync.authenticateCancel({ correlationId: cid });
      }
    };
  }, []);

  const startSession = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    setConfigMissing(null);
    try {
      const req =
        datasourceId !== undefined
          ? { providerId, datasourceId }
          : { providerId };
      const res = await window.api.sync.authenticateStart(req);
      if (res.ok) {
        if (res.result.kind === "oauth") {
          setCorrelationId(res.result.correlationId);
        } else {
          // Defensive: a credentials-form provider was somehow routed through
          // the OAuth form. This should be unreachable per the dialog's
          // descriptor-based dispatch, but surface inline rather than crash.
          setStartError(
            "Provider configuration mismatch — expected OAuth flow.",
          );
        }
      } else {
        if (res.error.tag === "service-config-missing") {
          setConfigMissing({
            tag: "service-config-missing",
            path: res.error.path,
          });
        } else {
          // engine-error / unknown-provider / validation-error — render the
          // tag + message so the user has something to read.
          const msg =
            "message" in res.error && res.error.message
              ? res.error.message
              : `Authentication failed (${res.error.tag}).`;
          setStartError(msg);
        }
      }
    } finally {
      setStarting(false);
    }
  }, [providerId, datasourceId]);

  const handleConnect = useCallback(() => {
    void startSession();
  }, [startSession]);

  const handleRetry = useCallback(() => {
    // Reset correlationId so useAuthSession goes back to "pending".
    setCorrelationId(null);
    void startSession();
  }, [startSession]);

  // Single-fire guard — useAuthSession may return the same `completed`
  // state across multiple renders before the parent unmounts the form;
  // a ref-tracked correlationId barrier prevents calling onSubmit twice.
  const completedFiredFor = useRef<string | null>(null);
  useEffect(() => {
    if (correlationId === null) return;
    if (sessionState.status !== "completed") return;
    if (completedFiredFor.current === correlationId) return;
    completedFiredFor.current = correlationId;
    onSubmit({
      _authCompleted: "completed",
      datasourceId: sessionState.datasourceId,
    });
  }, [correlationId, sessionState, onSubmit]);

  const isWaiting =
    starting || (correlationId !== null && sessionState.status === "pending");
  const isCancelled =
    correlationId !== null && sessionState.status === "cancelled";
  const isFailed =
    correlationId !== null && sessionState.status === "failed";
  const isTimeout =
    correlationId !== null && sessionState.status === "timeout";
  const hasFailureCopy =
    isCancelled ||
    isFailed ||
    isTimeout ||
    configMissing !== null ||
    startError !== null;

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
            : `Waiting for authentication in your browser…`}
        </p>
      )}

      {isCancelled && (
        <p
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-sm"
          data-testid="oauth-cancelled"
        >
          Authentication cancelled — you can try again.
        </p>
      )}

      {isTimeout && (
        <p
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-sm"
          data-testid="oauth-timeout"
        >
          Authentication timed out — please try again.
        </p>
      )}

      {configMissing !== null && (
        <p
          role="alert"
          className="text-destructive text-sm"
          data-testid="oauth-failed"
        >
          Service configuration missing. Add OAuth credentials to{" "}
          <code>{configMissing.path}</code>. See README §Provider OAuth
          registration.
        </p>
      )}

      {isFailed && configMissing === null && (
        <p
          role="alert"
          className="text-destructive text-sm"
          data-testid="oauth-failed"
        >
          {sessionState.status === "failed" && sessionState.message
            ? sessionState.message
            : "Authentication failed — please try again."}
        </p>
      )}

      {startError !== null && configMissing === null && !isFailed && (
        <p
          role="alert"
          className="text-destructive text-sm"
          data-testid="oauth-failed"
        >
          {startError}
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

        {hasFailureCopy ? (
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
