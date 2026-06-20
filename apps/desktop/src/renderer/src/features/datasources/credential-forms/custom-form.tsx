"use client";

//
// Custom credential form — implement-datasource-onboarding §23.
//
// Migrated from `actions.add({providerId, credentials})` to the same
// service-side two-step authenticate flow as the AWS access-key form (see
// `aws-access-key-form.tsx` for the rationale + design pointers).
//
// The user pastes a JSON blob; we `JSON.parse` it inside a try/catch and
// surface a parse error inline. On parse success the form proceeds with
// authenticateStart → authenticateComplete and surfaces backend errors
// (engine-error / unknown-provider / etc.) inline alongside the JSON
// parse error.

import { useCallback, useState, type FormEvent } from "react";

import type { ProviderId } from "@ft5/ipc-contracts";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export interface CustomFormProps {
  providerId: string;
  providerDisplayName: string;
  /** Present on the reconnect path only — omit for add-new-datasource. */
  datasourceId?: string;
  onSubmit: (credentials: Record<string, unknown>) => void;
  onBack: () => void;
}

export function CustomForm({
  providerId,
  providerDisplayName,
  datasourceId,
  onSubmit,
  onBack,
}: CustomFormProps) {
  const [json, setJson] = useState("{\n  \n}");
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      let parsed: Record<string, unknown>;
      try {
        const candidate = JSON.parse(json) as unknown;
        if (
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        ) {
          setParseError("Credentials must be a JSON object.");
          return;
        }
        parsed = candidate as Record<string, unknown>;
        setParseError(null);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : "Invalid JSON.");
        return;
      }

      setSubmitError(null);
      setSubmitting(true);
      try {
        const startReq =
          datasourceId !== undefined
            ? { providerId: providerId as ProviderId, datasourceId }
            : { providerId: providerId as ProviderId };
        const startRes = await window.api.sync.authenticateStart(startReq);
        if (!startRes.ok) {
          const msg =
            "message" in startRes.error && startRes.error.message
              ? startRes.error.message
              : `Authentication failed (${startRes.error.tag}).`;
          setSubmitError(msg);
          return;
        }
        if (startRes.result.kind !== "credentials-form") {
          setSubmitError(
            "Provider configuration mismatch — expected credentials form.",
          );
          return;
        }
        const completeRes = await window.api.sync.authenticateComplete({
          correlationId: startRes.result.correlationId,
          completion: { kind: "credentials-form", values: parsed },
        });
        if (!completeRes.ok) {
          const msg =
            "message" in completeRes.error && completeRes.error.message
              ? completeRes.error.message
              : `Authentication failed (${completeRes.error.tag}).`;
          setSubmitError(msg);
          return;
        }
        onSubmit({
          _authCompleted: "completed",
          datasourceId: completeRes.result.datasourceId,
        });
      } finally {
        setSubmitting(false);
      }
    },
    [json, providerId, datasourceId, onSubmit],
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3"
      aria-label={`${providerDisplayName} custom credentials`}
      data-testid="credential-form-custom"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="custom-credentials-json">
          Custom credentials (JSON)
        </Label>
        <textarea
          id="custom-credentials-json"
          name="customCredentials"
          rows={6}
          spellCheck={false}
          value={json}
          onChange={(e) => {
            setJson(e.target.value);
            if (parseError) setParseError(null);
            if (submitError) setSubmitError(null);
          }}
          className="border-input bg-transparent font-mono text-sm rounded-md border px-3 py-2 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>

      {parseError ? (
        <p role="alert" className="text-destructive text-sm">
          {parseError}
        </p>
      ) : null}

      {submitError ? (
        <p role="alert" className="text-destructive text-sm">
          {submitError}
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onBack}
          disabled={submitting}
        >
          Back
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? "Connecting…" : `Connect ${providerDisplayName}`}
        </Button>
      </div>
    </form>
  );
}
