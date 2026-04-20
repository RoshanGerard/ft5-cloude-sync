"use client";

import { useSyncExternalStore } from "react";

import type { FileEntry } from "@ft5/ipc-contracts";

import { cn } from "@/lib/utils";

import { FieldRow } from "./metadata/render-primitives";
import {
  PANE_PROVIDER_METADATA_LIMIT,
  fieldCatalog,
  paneFields,
  providerMetadataFields,
} from "./metadata/field-catalog";
import type { ExplorerStore } from "./store";
import { formatSize } from "./view-modes/details-format";

// Kept mounted in both states so the `data-[state=closed]` exit animation
// can play. `hidden` + `aria-hidden` remove the closed pane from the
// accessibility tree (design.md Decision 9 — "collapse animates (slide)").

export interface DetailsPaneProps {
  store: ExplorerStore;
}

export function DetailsPane({ store }: DetailsPaneProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  const open = state.detailsPaneOpen;
  const selectedIds = state.selection;
  const selectedEntries = state.entries.filter((e) => selectedIds.has(e.id));

  return (
    <aside
      aria-label="Details"
      aria-hidden={open ? undefined : true}
      hidden={!open}
      data-state={open ? "open" : "closed"}
      className={cn(
        "bg-card border-border flex w-80 shrink-0 flex-col border-l overflow-auto",
        // Slide motion gated on motion-safe: per the reduced-motion rules
        // that shadcn primitives follow; `data-[state=*]:` variants are
        // whitelisted by the motion-budget guardrail.
        "motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-right-8",
        "motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:slide-out-to-right-8",
      )}
    >
      <header className="border-border border-b px-4 py-3">
        <h2 className="text-sm font-medium">Details</h2>
      </header>
      <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
        {selectedEntries.length === 0 ? (
          <EmptyState />
        ) : selectedEntries.length === 1 ? (
          <SingleEntryBody entry={selectedEntries[0]!} />
        ) : (
          <MultiEntrySummary entries={selectedEntries} />
        )}
      </div>
    </aside>
  );
}

function EmptyState() {
  return (
    <p className="text-muted-foreground text-xs">Nothing selected</p>
  );
}

function SingleEntryBody({ entry }: { entry: FileEntry }) {
  const defsById = new Map(fieldCatalog.map((f) => [f.id, f] as const));
  const providerRows = providerMetadataFields(entry).slice(
    0,
    PANE_PROVIDER_METADATA_LIMIT,
  );

  return (
    <div className="flex flex-col gap-1">
      {paneFields.map((id) => {
        const def = defsById.get(id);
        if (!def) return null;
        const value = def.selector(entry);
        return (
          <FieldRow
            key={def.id}
            label={def.label}
            value={value === null ? null : String(value)}
            numeric={def.numeric}
          />
        );
      })}
      {providerRows.length > 0 ? (
        <div className="border-border mt-3 border-t pt-3">
          {providerRows.map((row) => (
            <FieldRow
              key={row.id}
              label={row.label}
              value={row.value === null ? null : String(row.value)}
              numeric={typeof row.value === "number"}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MultiEntrySummary({ entries }: { entries: FileEntry[] }) {
  const count = entries.length;
  // Summary sums files only — directories excluded per spec scenario
  // "Multi-selection shows a summary".
  const totalBytes = entries.reduce(
    (acc, e) => (e.kind === "file" ? acc + (e.size ?? 0) : acc),
    0,
  );
  const commonParent = commonParentPath(entries.map((e) => e.parentPath));

  return (
    <div className="flex flex-col gap-1">
      <FieldRow
        label="Selection"
        value={`${count} items selected`}
      />
      <FieldRow label="Combined size" value={formatSize(totalBytes)} numeric />
      <FieldRow label="Common parent" value={commonParent} />
    </div>
  );
}

// Path-segment longest prefix. `/a/b/x.txt` ∩ `/a/c/x.txt` → `/a`, not
// `/a/` — character-prefix would produce the latter, which misrepresents
// the path hierarchy.
export function commonParentPath(paths: string[]): string {
  if (paths.length === 0) return "/";
  const segmentsList = paths.map((p) => splitPath(p));
  const first = segmentsList[0]!;
  const common: string[] = [];
  for (let i = 0; i < first.length; i += 1) {
    const seg = first[i];
    if (segmentsList.every((segs) => segs[i] === seg)) {
      common.push(seg!);
    } else {
      break;
    }
  }
  if (common.length === 0) return "/";
  return `/${common.join("/")}`;
}

function splitPath(p: string): string[] {
  if (p === "/" || p === "") return [];
  const trimmed = p.startsWith("/") ? p.slice(1) : p;
  const noTrail = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  return noTrail.length === 0 ? [] : noTrail.split("/");
}
