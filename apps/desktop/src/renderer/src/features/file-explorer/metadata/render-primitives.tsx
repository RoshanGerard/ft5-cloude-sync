"use client";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";

// Render primitives consumed by the Details pane (Task 5.3/5.4) and the
// Properties modal (Task 5.5/5.6). Both render a label/value pair; the
// copy variant adds a clipboard-write button with a lucide `copy` glyph.
//
// The em-dash placeholder (\u2014) for null values mirrors the convention
// used by `view-modes/details-format.ts` — one visual vocabulary across
// the feature.

const EM_DASH = "\u2014";

export interface FieldRowProps {
  label: string;
  value: string | null;
  numeric?: boolean;
}

export function FieldRow({ label, value, numeric = false }: FieldRowProps) {
  const displayValue = value ?? EM_DASH;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground text-xs shrink-0">{label}</span>
      <span
        className={cn(
          "text-foreground min-w-0 flex-1 text-right truncate",
          numeric && "tabular-nums",
        )}
      >
        {displayValue}
      </span>
    </div>
  );
}

export interface FieldRowWithCopyProps extends FieldRowProps {
  // Raw value is what gets written to the clipboard. `value` is the
  // already-formatted display string (e.g. "12 KB"); `rawValue` carries
  // the original (e.g. the number 12288) so power-users get usable text.
  rawValue: string | number | boolean | null;
  // Optional rejection hook — Phase 5.6 wires a sonner toast through this.
  onCopyError?: (err: unknown) => void;
}

export function FieldRowWithCopy({
  label,
  value,
  numeric = false,
  rawValue,
  onCopyError,
}: FieldRowWithCopyProps) {
  const displayValue = value ?? EM_DASH;
  const disabled = rawValue === null;

  const onCopy = (): void => {
    if (disabled) return;
    const text = String(rawValue);
    // Guard against missing Clipboard API (CSP / test envs); forward any
    // rejection (permission denial, document-not-focused) to onCopyError.
    navigator.clipboard?.writeText(text)?.catch((err: unknown) => {
      onCopyError?.(err);
    });
  };

  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground text-xs shrink-0">{label}</span>
      <span
        className={cn(
          "text-foreground min-w-0 flex-1 text-right truncate",
          numeric && "tabular-nums",
        )}
      >
        {displayValue}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Copy ${label}`}
        onClick={onCopy}
        disabled={disabled}
        className="size-6 shrink-0"
      >
        <Icon name="copy" aria-hidden className="size-3" />
      </Button>
    </div>
  );
}
