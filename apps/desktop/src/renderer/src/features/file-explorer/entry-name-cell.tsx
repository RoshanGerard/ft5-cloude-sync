"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { cn } from "@/lib/utils";

import type { ExplorerStore } from "./store";

// Precedence: pendingOp (rename in flight) > editingId > static text.
// Row-level opacity-60 under rename compounds with this cell's opacity-60; reconciled in 6.11/6.12.

export interface EntryNameCellProps {
  store: ExplorerStore;
  entry: FileEntry;
  className?: string;
  /** Optional `title` attribute for truncated name cells. */
  titleAttr?: string;
}

export function EntryNameCell({
  store,
  entry,
  className,
  titleAttr,
}: EntryNameCellProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const pendingOp = state.pendingOps[entry.id];
  const isPendingRename = pendingOp?.kind === "rename";
  const isEditing = state.editingId === entry.id && !isPendingRename;

  if (isEditing) {
    return (
      <EntryNameInput
        key={entry.id}
        initialName={entry.name}
        onCommit={(value) => {
          void store.rename(entry.id, value);
        }}
        onCancel={() => store.cancelEdit()}
      />
    );
  }

  // Optimistic rename: show the requested name while the op is in flight.
  const displayName =
    isPendingRename && pendingOp?.newName !== undefined
      ? pendingOp.newName
      : entry.name;

  return (
    <span
      className={cn("truncate", isPendingRename && "opacity-60", className)}
      title={titleAttr}
    >
      {displayName}
    </span>
  );
}

interface EntryNameInputProps {
  initialName: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

function EntryNameInput({ initialName, onCommit, onCancel }: EntryNameInputProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.focus();
    el.setSelectionRange(0, el.value.length);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      onCommit(ref.current?.value ?? initialName);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    // Arrow keys inside the input must not bubble to the view-mode
    // keyboard handler and move row focus.
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight"
    ) {
      event.stopPropagation();
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      defaultValue={initialName}
      aria-label="Rename entry"
      onKeyDown={handleKeyDown}
      onBlur={onCancel}
      onClick={(e) => e.stopPropagation()}
      className="border-border focus:border-ring bg-background flex-1 min-w-0 rounded-sm border px-1 py-0 text-sm outline-none"
    />
  );
}
