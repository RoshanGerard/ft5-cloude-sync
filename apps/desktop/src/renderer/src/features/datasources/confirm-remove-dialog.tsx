"use client";

import { useRef, type JSX } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Pure presentational confirm dialog — shared by the file-explorer's
// <InvalidDatasourceState> Remove button AND the dashboard card's
// <InvalidDatasourceBanner> Remove button. The parent owns the IPC
// (window.api.datasources.remove); this component only collects the
// user's yes/no via onConfirm / onCancel.
//
// Spec reference:
//   openspec/changes/add-invalid-datasource-state/specs/file-explorer/
//     spec.md — "Invalid-datasource Remove flows through a shared
//     confirm dialog"
// Design reference: Decision 5 (single shared component, not inlined
//   per surface) and Decision 6 (destructive-styled Remove button).

export interface ConfirmRemoveDatasourceDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmRemoveDatasourceDialog({
  open,
  onConfirm,
  onCancel,
}: ConfirmRemoveDatasourceDialogProps): JSX.Element {
  const removeRef = useRef<HTMLButtonElement>(null);

  const handleOpenChange = (next: boolean): void => {
    // Radix routes Escape / overlay-click / close-button through onOpenChange.
    if (!next) onCancel();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          // Default Radix focus would land on the first focusable child
          // (the sr-only close button or the leading Cancel). Prevent
          // that and explicitly focus the destructive Remove button per
          // spec scenario "destructive Remove button has focus on open".
          event.preventDefault();
          removeRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Remove this datasource?</DialogTitle>
          <DialogDescription>
            This deletes the local registry entry; cloud files are not
            deleted.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            ref={removeRef}
            type="button"
            variant="destructive"
            onClick={onConfirm}
          >
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
