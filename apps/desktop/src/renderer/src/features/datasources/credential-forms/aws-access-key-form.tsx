"use client";

//
// AWS access-key credential form — four inputs (accessKeyId, secretAccessKey,
// region, bucket) with light-touch required-field validation (all non-empty).
// The real encryption + rotation flow is out of scope for this change; the
// mocked main-process handler accepts whatever the user typed.

import { useCallback, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface AwsAccessKeyFormProps {
  providerId: string;
  providerDisplayName: string;
  onSubmit: (credentials: Record<string, unknown>) => void;
  onBack: () => void;
}

export function AwsAccessKeyForm({
  providerDisplayName,
  onSubmit,
  onBack,
}: AwsAccessKeyFormProps) {
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [bucket, setBucket] = useState("");

  const canSubmit =
    accessKeyId.trim().length > 0 &&
    secretAccessKey.trim().length > 0 &&
    region.trim().length > 0 &&
    bucket.trim().length > 0;

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSubmit) return;
      onSubmit({
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        region: region.trim(),
        bucket: bucket.trim(),
      });
    },
    [canSubmit, accessKeyId, secretAccessKey, region, bucket, onSubmit],
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

      <div className="mt-2 flex items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          Connect {providerDisplayName}
        </Button>
      </div>
    </form>
  );
}
