"use client";

//
// OAuth credential form — mocked for the ui-ux-design change. The real OAuth
// flow wires up in a later phase; for now "Connect" resolves after `delayMs`
// (default 800ms, a realistic feel) with a fake credential blob.
//
// Shape: `{ providerId, onSubmit, onBack, delayMs? }`. The descriptor itself
// is passed by name + display name only — the dialog knows how to look it up,
// but the form needs neither the capabilities nor the icon (keeps it reusable
// across providers whose `credentialsSchema === "oauth"`).
//
// The `delayMs` prop exists for tests so they can pass `0` and avoid
// `vi.useFakeTimers()` plumbing, which interacts awkwardly with React async
// under @testing-library. Production callers leave it at the default.

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";

export interface OAuthFormProps {
  providerId: string;
  providerDisplayName: string;
  onSubmit: (credentials: Record<string, unknown>) => void;
  onBack: () => void;
  delayMs?: number;
}

export function OAuthForm({
  providerId,
  providerDisplayName,
  onSubmit,
  onBack,
  delayMs = 800,
}: OAuthFormProps) {
  const [pending, setPending] = useState(false);

  const handleConnect = useCallback(() => {
    setPending(true);
    // Simulate an OAuth round-trip. Resolves to a fake-but-structurally-
    // plausible credential blob so the downstream `add()` call has something
    // non-empty to forward.
    const credentials = {
      accessToken: `mock-${providerId}-token`,
      refreshToken: "mock-refresh",
    };
    const finish = () => {
      onSubmit(credentials);
    };
    if (delayMs <= 0) {
      finish();
      return;
    }
    window.setTimeout(finish, delayMs);
  }, [providerId, onSubmit, delayMs]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        You&apos;ll be redirected to sign in to {providerDisplayName} and grant
        access. This is a mocked flow during development — no real OAuth
        round-trip occurs.
      </p>

      {pending ? (
        <p
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-sm"
          data-testid="oauth-pending"
        >
          Connecting to {providerDisplayName}&hellip;
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onBack}
          disabled={pending}
        >
          Back
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleConnect}
          disabled={pending}
        >
          {pending ? "Connecting…" : `Connect ${providerDisplayName}`}
        </Button>
      </div>
    </div>
  );
}
