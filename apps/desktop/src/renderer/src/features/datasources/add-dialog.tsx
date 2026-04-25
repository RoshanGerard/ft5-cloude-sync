"use client";

//
// AddDatasourceDialog (tasks 6.1 / 6.2 / 6.3) — the add-datasource flow.
//
// Two internal steps:
//   1. Provider picker  → `<ProviderPicker />` from the frozen registry.
//   2. Credential form  → dispatched EXCLUSIVELY on the selected descriptor's
//      `credentialsSchema` field. There are NO `providerId === "..."`
//      branches anywhere in this file — the extensibility test
//      (add-dialog-extensibility.test.tsx) regex-scans the source to enforce
//      this.
//
// On submit: call `actions.add({providerId, credentials})`. On success, close
// the dialog via `onOpenChange(false)`; Radix restores focus to the element
// that opened the dialog (the toolbar trigger). On error, surface an inline
// error message in the dialog (no toast — the renderer does not currently
// mount a `<Toaster />`).
//
// Filename note: the radii-ceiling guardrail permits `rounded-lg` only on
// files whose basename contains `dialog` — `add-dialog.tsx` qualifies. The
// picker and credential-forms files do not use `rounded-lg`.

import { useCallback, useState } from "react";
import { providers } from "@ft5/ipc-contracts";
import type { ProviderDescriptor } from "@ft5/ipc-contracts";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { useDatasourceActions } from "./store";
import { ProviderPicker } from "./provider-picker";
import { OAuthForm } from "./credential-forms/oauth-form";
import { AwsAccessKeyForm } from "./credential-forms/aws-access-key-form";
import { CustomForm } from "./credential-forms/custom-form";

export interface AddDatasourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Element to restore focus to when the dialog closes. Typically the
   * toolbar trigger (or the empty-state CTA, whichever opened the dialog).
   * Radix's default focus restoration is unreliable in jsdom when the
   * opening click did not implicitly focus the trigger, so we explicitly
   * redirect focus here via `onCloseAutoFocus`.
   */
  returnFocusTo?: HTMLElement | null;
}

type Step = "pick" | "credentials";

export function AddDatasourceDialog({
  open,
  onOpenChange,
  returnFocusTo,
}: AddDatasourceDialogProps) {
  const [step, setStep] = useState<Step>("pick");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const actions = useDatasourceActions();

  const resetInternal = useCallback(() => {
    setStep("pick");
    setSelectedProviderId(null);
    setSubmitError(null);
    setSubmitting(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        // Defer the internal reset until after the close animation has
        // started — otherwise the picker briefly flashes back into view as
        // the dialog fades out. The parent is the source of truth for
        // `open` so it's safe to clear state immediately.
        resetInternal();
      }
      onOpenChange(next);
    },
    [onOpenChange, resetInternal],
  );

  const handleProviderSelected = useCallback((providerId: string) => {
    setSelectedProviderId(providerId);
    setSubmitError(null);
    setStep("credentials");
  }, []);

  const handleBack = useCallback(() => {
    setSelectedProviderId(null);
    setSubmitError(null);
    setStep("pick");
  }, []);

  const handleCredentialsSubmit = useCallback(
    async (credentials: Record<string, unknown>) => {
      if (selectedProviderId === null) return;
      setSubmitError(null);
      setSubmitting(true);

      // OAuth forms signal completion via a sentinel key. The consent broker
      // has already registered the datasource in the main process, so we
      // refresh the list instead of calling add().
      if (credentials._oauthConsent === "completed") {
        setSubmitting(false);
        void actions.refresh();
        handleOpenChange(false);
        return;
      }

      try {
        await actions.add({ providerId: selectedProviderId, credentials });
        setSubmitting(false);
        // Close via the controlled prop; Radix restores focus to the opener.
        handleOpenChange(false);
      } catch (err) {
        setSubmitting(false);
        const message =
          err instanceof Error
            ? err.message
            : "Failed to add datasource. Please try again.";
        setSubmitError(message);
      }
    },
    [actions, selectedProviderId, handleOpenChange],
  );

  const descriptor = resolveDescriptor(selectedProviderId);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-describedby="add-datasource-dialog-description"
        onCloseAutoFocus={(event) => {
          if (returnFocusTo && returnFocusTo.isConnected) {
            event.preventDefault();
            returnFocusTo.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Add datasource</DialogTitle>
          <DialogDescription id="add-datasource-dialog-description">
            {step === "pick"
              ? "Pick a cloud provider to connect."
              : descriptor
                ? `Sign in or enter credentials for ${descriptor.displayName}.`
                : "Enter your credentials."}
          </DialogDescription>
        </DialogHeader>

        {step === "pick" ? (
          <ProviderPicker onSelect={handleProviderSelected} />
        ) : descriptor ? (
          <CredentialStep
            descriptor={descriptor}
            submitting={submitting}
            submitError={submitError}
            onSubmit={(credentials) => {
              void handleCredentialsSubmit(credentials);
            }}
            onBack={handleBack}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface CredentialStepProps {
  descriptor: ProviderDescriptor;
  submitting: boolean;
  submitError: string | null;
  onSubmit: (credentials: Record<string, unknown>) => void;
  onBack: () => void;
}

function CredentialStep({
  descriptor,
  submitting,
  submitError,
  onSubmit,
  onBack,
}: CredentialStepProps) {
  // Dispatch EXCLUSIVELY on `credentialsSchema`. Adding a new schema value to
  // `CredentialsSchema` will surface here as a TypeScript exhaustiveness
  // error — that's the intended "one edit point" for the extensibility story.
  const FormComponent = selectFormComponent(descriptor.credentialsSchema);

  return (
    <div className="flex flex-col gap-3">
      <FormComponent
        providerId={descriptor.id}
        providerDisplayName={descriptor.displayName}
        onSubmit={onSubmit}
        onBack={onBack}
      />
      {submitting ? (
        <p
          role="status"
          aria-live="polite"
          className="text-muted-foreground text-sm"
        >
          Saving datasource&hellip;
        </p>
      ) : null}
      {submitError ? (
        <p role="alert" className="text-destructive text-sm">
          {submitError}
        </p>
      ) : null}
    </div>
  );
}

type FormComponent = typeof OAuthForm | typeof AwsAccessKeyForm | typeof CustomForm;

function selectFormComponent(
  schema: ProviderDescriptor["credentialsSchema"],
): FormComponent {
  switch (schema) {
    case "oauth":
      return OAuthForm;
    case "aws-access-key":
      return AwsAccessKeyForm;
    case "custom":
      return CustomForm;
    default: {
      // Exhaustiveness check — if `CredentialsSchema` grows a new variant the
      // compiler will flag this line, pointing the implementer to the single
      // edit site.
      const _exhaustive: never = schema;
      void _exhaustive;
      return CustomForm;
    }
  }
}

function resolveDescriptor(
  providerId: string | null,
): ProviderDescriptor | null {
  if (providerId === null) return null;
  const registry = providers as Record<string, ProviderDescriptor>;
  return registry[providerId] ?? null;
}
