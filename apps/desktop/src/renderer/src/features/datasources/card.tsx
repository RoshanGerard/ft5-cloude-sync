"use client";

//
// DatasourceCard (task 5.4) — composes a single summary into a dense card.
//
// Layout, top-to-bottom:
//
//   ┌──────────────────────────────────────────────┐
//   │ [icon] Display Name        [status] [⋯ menu] │   <- header row
//   │ Last sync: 5m ago   |   1,240 items          │   <- meta row
//   │ ▓▓▓▓▓▓░░░░  12 GB / 16 GB                    │   <- usage (when quota)
//   │ error reason, if status === "error"          │   <- conditional
//   └──────────────────────────────────────────────┘
//
// Visual refinement constraints (design.md Decision 8/10/11):
//   - Card root padding `p-4`, override the shadcn default `py-6`.
//   - Numeric text (item count, usage values, last-sync digits) uses
//     Tailwind's `tabular-nums` utility for stable digit width.
//   - Syncing status dot gets `motion-safe:animate-sync-pulse` — the
//     motion-safe: variant ensures reduced-motion users see a static dot,
//     complementing the reduced-motion @media wrapping in globals.css.
//   - No `backdrop-blur` — glass is reserved for overlays (Dialog,
//     DropdownMenu, Tooltip).
//   - No rounded-lg/xl/2xl/3xl or fully-rounded utility — the radii-ceiling
//     guardrail caps feature code at rounded-md. The syncing dot therefore
//     renders as an SVG <circle> rather than an equivalent radius class on a
//     <span>.

import { useCallback, useMemo } from "react";
import { providers } from "@ft5/ipc-contracts";
import type {
  DatasourceStatus,
  DatasourceSummary,
  ProviderDescriptor,
} from "@ft5/ipc-contracts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon, type IconName } from "@/components/icon";
import { cn } from "@/lib/utils";

import { useDatasourceActions } from "./store";

export interface DatasourceCardProps {
  summary: DatasourceSummary;
}

export function DatasourceCard({ summary }: DatasourceCardProps) {
  const descriptor = getDescriptor(summary.providerId);
  const actions = useDatasourceActions();

  const quotaEnabled = descriptor?.capabilities.quota === true;
  const providerIconName = iconNameFromDescriptor(descriptor);
  const providerDisplayName = descriptor?.displayName ?? summary.providerId;

  const onSyncNow = useCallback(() => {
    void actions.action({ datasourceId: summary.id, action: "sync-now" });
  }, [actions, summary.id]);

  const onPauseOrResume = useCallback(() => {
    const next =
      summary.status === "paused" || summary.status === "error"
        ? "resume"
        : "pause";
    void actions.action({ datasourceId: summary.id, action: next });
  }, [actions, summary.id, summary.status]);

  const onUpload = useCallback(() => {
    void actions.upload({ datasourceId: summary.id });
  }, [actions, summary.id]);

  const onRemove = useCallback(() => {
    void actions.remove({ datasourceId: summary.id });
  }, [actions, summary.id]);

  const pauseLabel =
    summary.status === "paused" || summary.status === "error"
      ? "Resume"
      : "Pause";

  return (
    <Card
      data-testid="datasource-card"
      data-datasource-id={summary.id}
      className="gap-3 p-4"
    >
      <header className="flex items-start gap-3">
        {providerIconName ? (
          <Icon
            name={providerIconName}
            data-testid="datasource-provider-icon"
            data-icon={providerIconName}
            aria-hidden
            className="text-muted-foreground mt-0.5 size-4 shrink-0"
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="truncate text-sm font-semibold">
            {summary.displayName}
          </h3>
          <p className="text-muted-foreground text-xs">{providerDisplayName}</p>
        </div>
        <StatusBadge
          status={summary.status}
          errorReason={summary.errorReason}
        />
        <QuickActionsMenu
          pauseLabel={pauseLabel}
          onSyncNow={onSyncNow}
          onPauseOrResume={onPauseOrResume}
          onUpload={onUpload}
          onRemove={onRemove}
        />
      </header>

      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span data-testid="datasource-last-sync" className="tabular-nums">
          {formatLastSync(summary.lastSyncAt)}
        </span>
        <span aria-hidden>·</span>
        <span data-testid="datasource-item-count" className="tabular-nums">
          {formatItemCount(summary.itemCount)} items
        </span>
      </div>

      {quotaEnabled && summary.usage ? (
        <UsageBar used={summary.usage.used} quota={summary.usage.quota} />
      ) : null}

      {summary.status === "error" && summary.errorReason ? (
        <p className="text-destructive text-xs">{summary.errorReason}</p>
      ) : null}
    </Card>
  );
}

function getDescriptor(providerId: string): ProviderDescriptor | undefined {
  const registry = providers as Record<string, ProviderDescriptor>;
  return registry[providerId];
}

// The provider registry stores its icon as an opaque string; we map to the
// local IconName union here so consumers don't have to care about the union
// boundary. Any unknown string resolves to `undefined`, and the card simply
// skips rendering the icon — the registry is expected to stay in sync with
// the adapter.
function iconNameFromDescriptor(
  descriptor: ProviderDescriptor | undefined,
): IconName | null {
  if (!descriptor) return null;
  const known: IconName[] = [
    "sun",
    "moon",
    "monitor",
    "laptop",
    "cloud",
    "database",
    "hard-drive",
  ];
  return known.includes(descriptor.icon as IconName)
    ? (descriptor.icon as IconName)
    : null;
}

function StatusBadge({
  status,
  errorReason,
}: {
  status: DatasourceStatus;
  errorReason?: string;
}) {
  const variant = statusBadgeVariant(status);
  const accessibleName = useMemo(() => {
    if (status === "error" && errorReason) {
      return `Status: error — ${errorReason}`;
    }
    return `Status: ${status}`;
  }, [status, errorReason]);

  return (
    <Badge
      data-testid="datasource-status"
      variant={variant}
      aria-label={accessibleName}
      className="shrink-0 gap-1.5"
    >
      {status === "syncing" ? <SyncingDot /> : null}
      <span className="capitalize">{status}</span>
    </Badge>
  );
}

function statusBadgeVariant(
  status: DatasourceStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "connected":
      return "secondary";
    case "syncing":
      return "default";
    case "paused":
      return "outline";
    case "error":
      return "destructive";
  }
}

// Syncing dot rendered as an SVG <circle>. We can't use a fully-rounded
// Tailwind utility on a <span> because the radii-ceiling guardrail caps
// feature code at rounded-md. SVG gives us the circle geometry without
// touching the Tailwind radius scale. The motion-safe: variant of
// animate-sync-pulse means the pulse kicks in only when the OS preference is
// not "reduce".
function SyncingDot() {
  return (
    <svg
      data-testid="datasource-syncing-dot"
      viewBox="0 0 8 8"
      role="presentation"
      aria-hidden
      className={cn(
        "size-2 shrink-0 fill-current",
        "motion-safe:animate-sync-pulse",
      )}
    >
      <circle cx="4" cy="4" r="3" />
    </svg>
  );
}

interface QuickActionsMenuProps {
  pauseLabel: string;
  onSyncNow: () => void;
  onPauseOrResume: () => void;
  onUpload: () => void;
  onRemove: () => void;
}

function QuickActionsMenu({
  pauseLabel,
  onSyncNow,
  onPauseOrResume,
  onUpload,
  onRemove,
}: QuickActionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Quick actions"
          className="size-7 shrink-0"
        >
          <span aria-hidden className="text-base leading-none">
            ⋯
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onSyncNow}>Sync now</DropdownMenuItem>
        <DropdownMenuItem onSelect={onPauseOrResume}>
          {pauseLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onUpload}>
          Upload from local…
        </DropdownMenuItem>
        <DropdownMenuItem disabled>Settings</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRemove}>Remove</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UsageBar({ used, quota }: { used: number; quota: number }) {
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  return (
    <div
      data-testid="datasource-usage"
      className="flex flex-col gap-1 tabular-nums"
    >
      <Progress value={pct} aria-label={`Storage used: ${pct}%`} />
      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>{formatBytes(used)}</span>
        <span>{formatBytes(quota)}</span>
      </div>
    </div>
  );
}

// --- formatting helpers --- kept inline so we don't pull a date library.

function formatItemCount(n: number): string {
  // Intl.NumberFormat gives us locale-aware grouping separators without a
  // dependency; for SSR consistency we explicitly request en-US. Numeric
  // fields live inside `.tabular-nums` wrappers so digit width stays stable.
  return new Intl.NumberFormat("en-US").format(n);
}

function formatLastSync(ts: number | null): string {
  if (ts === null) return "Never synced";
  const now = Date.now();
  const deltaMs = Math.max(0, now - ts);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return "Just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function formatBytes(n: number): string {
  // Binary units (GiB), rendered as GB for readability. `maximumFractionDigits`
  // keeps the number dense and stable under tabular-nums.
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value = value / 1024;
    unit++;
  }
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value)} ${units[unit]}`;
}
