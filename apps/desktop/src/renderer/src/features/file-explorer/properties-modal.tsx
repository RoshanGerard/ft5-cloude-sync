"use client";

import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import type { FileEntry } from "@ft5/ipc-contracts";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  fieldCatalog,
  modalFields,
  providerMetadataFields,
} from "./metadata/field-catalog";
import { FieldRowWithCopy } from "./metadata/render-primitives";
import type { ExplorerStore } from "./store";

// design.md Decision 4: the modal is the "give me everything" surface —
// every catalog field listed in `modalFields` plus every provider metadata
// row, each with a copy affordance.

export interface PropertiesModalProps {
  store: ExplorerStore;
}

export function PropertiesModal({ store }: PropertiesModalProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const entry = state.propertiesEntry;
  const open = entry !== null;

  const handleOpenChange = (next: boolean): void => {
    if (!next) store.closeProperties();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {entry !== null ? (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Properties</DialogTitle>
            <DialogDescription className="sr-only">
              Full metadata for {entry.name}
            </DialogDescription>
          </DialogHeader>
          <PropertiesBody entry={entry} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function onCopyError(err: unknown): void {
  // Clipboard rejection surfaces as a sonner toast; swallow the error
  // object — the user-facing message is what matters.
  void err;
  toast.error("Failed to copy to clipboard");
}

function PropertiesBody({ entry }: { entry: FileEntry }) {
  const defsById = new Map(fieldCatalog.map((f) => [f.id, f] as const));
  const providerRows = providerMetadataFields(entry);

  return (
    <div className="flex flex-col gap-1">
      {modalFields.map((id) => {
        const def = defsById.get(id);
        if (!def) return null;
        const value = def.selector(entry);
        const rawValue = def.rawSelector
          ? def.rawSelector(entry)
          : value;
        return (
          <FieldRowWithCopy
            key={def.id}
            label={def.label}
            value={value === null ? null : String(value)}
            numeric={def.numeric}
            rawValue={rawValue}
            onCopyError={onCopyError}
          />
        );
      })}
      {providerRows.length > 0 ? (
        <div className="border-border mt-3 border-t pt-3 flex flex-col gap-1">
          {providerRows.map((row) => (
            <FieldRowWithCopy
              key={row.id}
              label={row.label}
              value={row.value === null ? null : String(row.value)}
              numeric={typeof row.value === "number"}
              rawValue={row.value}
              onCopyError={onCopyError}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
