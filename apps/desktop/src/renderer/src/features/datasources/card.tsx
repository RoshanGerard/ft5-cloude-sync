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
import { Icon, isIconName, type IconName } from "@/components/icon";
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

// The provider registry stores its icon as an opaque string; we narrow to
// the IconName union via the adapter's `isIconName` type guard. This keeps
// the check in sync with the adapter's REGISTRY — code-review I-2
// (review-round-1) flagged the previous hardcoded allowlist as drift-prone
// once the adapter grew new names for Decision 15's primary-CTA glyphs.
// Unknown strings resolve to `null` and the card skips rendering the icon.
function iconNameFromDescriptor(
  descriptor: ProviderDescriptor | undefined,
): IconName | null {
  if (!descriptor) return null;
  return isIconName(descriptor.icon) ? descriptor.icon : null;
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

// Syncing dot — radar-ping composition: a static solid dot with an outer
// ring that expands outward + fades to zero, restarting every cycle.
// Round-3 user feedback: the opacity-only pulse wasn't "decent" enough;
// this adds a visible expanding-ring cue that reads as "actively working"
// without being aggressive (no rotation, no scale on the dot itself).
//
// SVG geometry over a Tailwind radius utility — the radii-ceiling
// guardrail caps feature code at rounded-md, so the circle has to come
// from an SVG primitive rather than a Tailwind radius class.
//
// Motion:
//   - the inner solid dot keeps `motion-safe:animate-sync-pulse` (gentle
//     opacity breathing);
//   - the outer ring uses `motion-safe:animate-sync-ripple` (expanding
//     scale + fade-out), needing `transform-origin: center` +
//     `transform-box: fill-box` so the scale transform pivots around
//     the ring's centre inside the SVG coordinate system.
// Both animations are gated by `motion-safe:` so `prefers-reduced-motion:
// reduce` users see a static, non-animating dot (no ring motion).
function SyncingDot() {
  // viewBox is intentionally 3x the visible dot size so the ring has room
  // to expand to scale(2.4) without hitting the SVG clip boundary. At
  // viewBox="0 0 24 24" with dot radius 4 at centre (12, 12), the ring's
  // bounding box at peak scale is (12 ± 9.6) = 2.4 → 21.6, inside the
  // 0..24 window. overflow="visible" is belt-and-braces in case a
  // descendant parent applies overflow:hidden.
  //
  // Render size: `size-3` (12px). Rendered ring radius 2px → peak 4.8px.
  // Visible but subtle; badge height unchanged (text dominates).
  return (
    <svg
      data-testid="datasource-syncing-dot"
      viewBox="0 0 24 24"
      overflow="visible"
      role="presentation"
      aria-hidden
      className={cn("size-3 shrink-0 fill-current")}
    >
      {/* Expanding ring — radar-ping. Pivot around centre via fill-box. */}
      <circle
        cx="12"
        cy="12"
        r="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className={cn("motion-safe:animate-sync-ripple")}
        style={{ transformOrigin: "center", transformBox: "fill-box" }}
      />
      {/* Solid dot with the existing gentle pulse breathing. */}
      <circle
        cx="12"
        cy="12"
        r="4"
        className={cn("motion-safe:animate-sync-pulse")}
        style={{ transformOrigin: "center", transformBox: "fill-box" }}
      />
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
  // Decision 15 (review-round-1): every menu item gets a leading lucide
  // glyph. Pause/Resume swaps between `pause` and `play` so the glyph
  // tracks the label's toggle semantics.
  const pauseIcon: IconName = pauseLabel === "Resume" ? "play" : "pause";
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
        <DropdownMenuItem onSelect={onSyncNow}>
          <Icon name="refresh-cw" className="size-4" aria-hidden />
          Sync now
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPauseOrResume}>
          <Icon name={pauseIcon} className="size-4" aria-hidden />
          {pauseLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onUpload}>
          <Icon name="upload" className="size-4" aria-hidden />
          Upload from local…
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <Icon name="settings" className="size-4" aria-hidden />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRemove}>
          <Icon name="trash-2" className="size-4" aria-hidden />
          Remove
        </DropdownMenuItem>
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
