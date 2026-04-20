"use client";

import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Pure presentational dialog — the store's `remove` action owns the IPC
// + toast lifecycle; this component only collects the user's yes/no.

export interface ConfirmDeleteDialogProps {
  open: boolean;
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeleteDialog({
  open,
  count,
  onConfirm,
  onCancel,
}: ConfirmDeleteDialogProps): JSX.Element {
  const noun = count === 1 ? "item" : "items";
  const handleOpenChange = (next: boolean): void => {
    // Radix routes Escape / overlay-click / close-button through onOpenChange.
    if (!next) onCancel();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Delete ${count} ${noun}?`}</DialogTitle>
          <DialogDescription>
            {`Delete ${count} ${noun}? This action cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
