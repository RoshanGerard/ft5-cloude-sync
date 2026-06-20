"use client";

//
// AWS access-key credential form — implement-datasource-onboarding §23.
//
// Migrated from the legacy `actions.add({providerId, credentials})` shape to
// the service-side two-step authenticate flow:
//
//   1. User fills the four inputs (accessKeyId, secretAccessKey, region,
//      bucket) and submits.
//   2. Form calls window.api.sync.authenticateStart({providerId: "amazon-s3"}).
//      The service stages a `credentials-form` intent and returns
//      { ok: true, result: { correlationId, kind: "credentials-form",
//      formSchema: "aws-access-key" } } (or { ok: false, error } for engine /
//      validation failures).
//   3. Form calls window.api.sync.authenticateComplete({correlationId,
//      completion: {kind: "credentials-form", values}}). On `ok: true` the
//      form fires onSubmit({_authCompleted: "completed", datasourceId}); on
//      `ok: false` the form renders an inline error.
//
// The `actions.add(...)` codepath is no longer touched here.

import { useCallback, useState, type FormEvent } from "react";

import type { ProviderId } from "@ft5/ipc-contracts";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface AwsAccessKeyFormProps {
  providerId: string;
  providerDisplayName: string;
  /** Present on the reconnect path only — omit for add-new-datasource. */
  datasourceId?: string;
  onSubmit: (credentials: Record<string, unknown>) => void;
  onBack: () => void;
}

export function AwsAccessKeyForm({
  providerId,
  providerDisplayName,
  datasourceId,
  onSubmit,
  onBack,
}: AwsAccessKeyFormProps) {
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [bucket, setBucket] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    accessKeyId.trim().length > 0 &&
    secretAccessKey.trim().length > 0 &&
    region.trim().length > 0 &&
    bucket.trim().length > 0 &&
    !submitting;

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSubmit) return;
      setError(null);
      setSubmitting(true);
      const values = {
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        region: region.trim(),
        bucket: bucket.trim(),
      };
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
          setError(msg);
          return;
        }
        if (startRes.result.kind !== "credentials-form") {
          // Defensive: the dialog routes this form to credentials-form
          // providers only, but if a provider's classification flips at
          // runtime the renderer should not crash.
          setError(
            "Provider configuration mismatch — expected credentials form.",
          );
          return;
        }
        const completeRes = await window.api.sync.authenticateComplete({
          correlationId: startRes.result.correlationId,
          completion: { kind: "credentials-form", values },
        });
        if (!completeRes.ok) {
          const msg =
            "message" in completeRes.error && completeRes.error.message
              ? completeRes.error.message
              : `Authentication failed (${completeRes.error.tag}).`;
          setError(msg);
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
    [
      canSubmit,
      providerId,
      datasourceId,
      accessKeyId,
      secretAccessKey,
      region,
      bucket,
      onSubmit,
    ],
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3"
      aria-label={`${providerDisplayName} access-key credentials`}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="aws-access-key-id">Access key ID</Label>
        <Input
          id="aws-access-key-id"
          name="accessKeyId"
          autoComplete="off"
          spellCheck={false}
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="aws-secret-access-key">Secret access key</Label>
        <Input
          id="aws-secret-access-key"
          name="secretAccessKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="aws-region">Region</Label>
        <Input
          id="aws-region"
          name="region"
          autoComplete="off"
          spellCheck={false}
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="aws-bucket">Bucket</Label>
        <Input
          id="aws-bucket"
          name="bucket"
          autoComplete="off"
          spellCheck={false}
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          required
        />
      </div>

      {error !== null ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
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
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {submitting ? "Connecting…" : `Connect ${providerDisplayName}`}
        </Button>
      </div>
    </form>
  );
}
