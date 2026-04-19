"use client";

//
// Custom credential form — the extensibility-slot placeholder. Matched when a
// registry entry declares `credentialsSchema: "custom"`. The user pastes a
// JSON blob; we `JSON.parse` it inside a try/catch and surface a parse error
// inline. Intentionally minimal — this is a seam for future provider types,
// not a polished surface.

import { useCallback, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export interface CustomFormProps {
  providerId: string;
  providerDisplayName: string;
  onSubmit: (credentials: Record<string, unknown>) => void;
  onBack: () => void;
}

export function CustomForm({
  providerDisplayName,
  onSubmit,
  onBack,
}: CustomFormProps) {
  const [json, setJson] = useState("{\n  \n}");
  const [parseError, setParseError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      try {
        const parsed = JSON.parse(json) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setParseError("Credentials must be a JSON object.");
          return;
        }
        setParseError(null);
        onSubmit(parsed as Record<string, unknown>);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : "Invalid JSON.");
      }
    },
    [json, onSubmit],
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
          }}
          className="border-input bg-transparent font-mono text-sm rounded-md border px-3 py-2 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>

      {parseError ? (
        <p role="alert" className="text-destructive text-sm">
          {parseError}
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" size="sm">
          Connect {providerDisplayName}
        </Button>
      </div>
    </form>
  );
}
