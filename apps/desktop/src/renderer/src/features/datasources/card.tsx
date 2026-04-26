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
//   - Syncing status dot gets bare `animate-sync-pulse` / `animate-sync-ripple`
//     utilities — custom product animations default to always-on. Users who
//     want OS reduce-motion honoured enable Motion Safe in Settings, which
//     writes `data-motion="safe"` on <html> and a CSS override in globals.css
//     disables these animations when the OS also signals reduce-motion.
//   - No `backdrop-blur` — glass is reserved for overlays (Dialog,
//     DropdownMenu, Tooltip).
//   - No rounded-lg/xl/2xl/3xl or fully-rounded utility — the radii-ceiling
//     guardrail caps feature code at rounded-md. The syncing dot therefore
//     renders as an SVG <circle> rather than an equivalent radius class on a
//     <span>.
//
// Post-Section-9 cleanup: the `STUB_CONFLICT_RESOLVER` placeholder previously
// passed to <UploadDialog> is replaced with the real
// `useConflictResolutionDialog()` hook + `<ConflictResolutionDialog>` from
// the file-explorer feature. Real conflicts now drive the actual dialog.

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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

import {
  useDatasourceActions,
  useDatasourceJobs,
  useDatasourceUploadProgress,
  useConsentSession,
} from "./store";
import { UploadDialog } from "@/features/file-explorer/upload-dialog";
import { createUploadJobToaster } from "@/features/file-explorer/upload-job-toast";
import {
  ConflictResolutionDialog,
  useConflictResolutionDialog,
} from "@/features/file-explorer/conflict-resolution-dialog";
import { ConfirmRemoveDatasourceDialog } from "./confirm-remove-dialog";

export interface DatasourceCardProps {
  summary: DatasourceSummary;
}

// Decision 13 — Renderer card sync-state derivation. Sync-event state wins
// over `summary.status` ONLY when an in-flight `kind === "sync"` job exists
// for this datasource; otherwise the engine-bus `summary.status` is the
// fallback. Upload-kind jobs do NOT change the status badge — they show as
// a separate Progress bar (task 10.3/10.4). `waiting-network` surfaces as
// its own display state so `StatusBadge` can render the zinc-dot + wifi-off
// visual variant; `running` and `queued` both collapse to `"syncing"`
// (queued is visually identical to running per Decision 13).
export type CardDisplayStatus = DatasourceStatus | "waiting-network";

function deriveDisplayStatus(
  summary: DatasourceSummary,
  jobs: ReadonlyArray<{ readonly kind: string; readonly status: string }>,
): CardDisplayStatus {
  const hasRunningSync = jobs.some(
    (j) => j.kind === "sync" && j.status === "running",
  );
  if (hasRunningSync) return "syncing";
  const hasWaitingNetwork = jobs.some(
    (j) => j.kind === "sync" && j.status === "waiting-network",
  );
  if (hasWaitingNetwork) return "waiting-network";
  const hasQueuedSync = jobs.some(
    (j) => j.kind === "sync" && j.status === "queued",
  );
  if (hasQueuedSync) return "syncing";
  return summary.status;
}

export function DatasourceCard({ summary }: DatasourceCardProps) {
  const descriptor = getDescriptor(summary.providerId);
  const actions = useDatasourceActions();
  const router = useRouter();
  const jobs = useDatasourceJobs(summary.id);
  const displayStatus = deriveDisplayStatus(summary, jobs);
  const uploadProgress = useDatasourceUploadProgress(summary.id);

  const quotaEnabled = descriptor?.capabilities.quota === true;
  const providerIconName = iconNameFromDescriptor(descriptor);
  const providerDisplayName = descriptor?.displayName ?? summary.providerId;

  const onExplore = useCallback(() => {
    router.push(`/datasources/explore?id=${summary.id}`);
  }, [router, summary.id]);

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

  // Task 6.3 rewire — instead of calling the retired `datasources.upload`
  // IPC (which opened a native picker and hard-coded `targetPath = "/" +
  // basename`), the quick-action now opens the in-app Upload dialog with
  // the destination defaulted to the datasource root. The user picks both
  // the files AND the destination folder inside the dialog.
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const onUpload = useCallback(() => {
    setUploadDialogOpen(true);
  }, []);

  // Task 9.2 — production Sonner-backed per-job toaster, instantiated
  // once per card mount and shared with the upload dialog so the dashboard
  // upload entry point gets the same per-job progress UX as the in-explorer
  // drop-zone path.
  const toaster = useMemo(() => createUploadJobToaster(), []);

  // Task 7 wiring (post-Section-9 cleanup) — production shadcn-dialog
  // conflict resolver, instantiated once per card mount. Replaces the
  // earlier `STUB_CONFLICT_RESOLVER` placeholder. Real conflicts now drive
  // <ConflictResolutionDialog> rendered below.
  const { resolver: conflictResolver, dialogProps: conflictDialogProps } =
    useConflictResolutionDialog();

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
          status={displayStatus}
          errorReason={summary.errorReason}
        />
        <QuickActionsMenu
          pauseLabel={pauseLabel}
          onExplore={onExplore}
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

      {uploadProgress !== null ? (
        // Decision 13 — upload-progress bar. Renders iff at least one
        // upload-kind job for this datasource is in [running|queued|
        // waiting-network]; the active-job tiebreak is in
        // useDatasourceUploadProgress. Bar value comes from the same
        // SyncEvent stream that drives `jobsByDatasource` (no separate
        // uploadProgress channel consumer per the amended Decision 13).
        // The testid + data-job-id live on the Radix Progress root so
        // tests can read `aria-valuenow` directly off the element.
        <Progress
          data-testid="datasource-upload-progress"
          data-job-id={uploadProgress.jobId}
          value={uploadProgress.percent}
          aria-label={`Upload progress: ${uploadProgress.percent}%`}
        />
      ) : null}

      {quotaEnabled && summary.usage ? (
        <UsageBar used={summary.usage.used} quota={summary.usage.quota} />
      ) : null}

      {summary.status === "error" &&
        (summary.errorKind === "auth-revoked" ||
          summary.errorKind === "auth-expired") ? (
        <AuthErrorBanner
          providerId={summary.providerId}
          datasourceId={summary.id}
        />
      ) : summary.status === "error" &&
        summary.errorKind === "invalid-datasource" ? (
        <InvalidDatasourceBanner
          providerId={summary.providerId}
          datasourceId={summary.id}
        />
      ) : summary.status === "error" && summary.errorReason ? (
        <p
          data-testid="error-reason-text"
          className="text-destructive text-xs"
        >
          {summary.errorReason}
        </p>
      ) : null}
      {/* Upload dialog — portalled by shadcn <Dialog>, so visual placement
          inside <Card> is immaterial; keeping it here keeps the surface
          co-located with the quick-action handler that opens it. The
          dialog defaults its destination to `/` (root) per spec when
          opened from the dashboard card; the toolbar Upload button
          (Task 6.4) opens the same component with the file-explorer's
          currentPath instead. Section 9 wired the production toaster;
          Section 7's conflict-resolver dialog is wired here too — both
          ports are now production-grade. */}
      <UploadDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        datasourceId={summary.id}
        datasourceName={summary.displayName}
        initialDestination="/"
        conflictResolver={conflictResolver}
        toaster={toaster}
      />
      {/* Conflict-resolution dialog (Task 7) — Radix portal, so visual
          placement is immaterial. The hook above owns its open/close
          state and is fed by the same orchestrator the UploadDialog
          uses. */}
      <ConflictResolutionDialog {...conflictDialogProps} />
    </Card>
  );
}

// Auth-error banner shown when `errorKind` is an auth-class tag.
// Provides a one-click Reconnect that starts a scoped consent session for
// this specific datasource (re-auth path, not add-new path).
function AuthErrorBanner({
  providerId,
  datasourceId,
}: {
  providerId: string;
  datasourceId: string;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionState = useConsentSession(sessionId ?? "__none__");

  const handleReconnect = useCallback(async () => {
    const res = await window.api.datasources.startConsent({
      providerId,
      datasourceId,
    });
    setSessionId(res.sessionId);
  }, [providerId, datasourceId]);

  const isWaiting =
    sessionId !== null && sessionState.status === "pending";
  const isFailed =
    sessionId !== null &&
    (sessionState.status === "cancelled" ||
      sessionState.status === "failed" ||
      sessionState.status === "timeout");

  return (
    <div
      data-testid="auth-error-banner"
      aria-label="Authorization required"
      className="flex items-center justify-between gap-2"
    >
      <p className="text-destructive text-xs">
        {isWaiting
          ? "Waiting for browser consent…"
          : isFailed
            ? "Reconnect failed — please try again."
            : "Authentication expired — please reconnect."}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isWaiting}
        onClick={() => { void handleReconnect(); }}
      >
        {isWaiting ? "Connecting…" : "Reconnect"}
      </Button>
    </div>
  );
}

// Invalid-datasource banner shown when `errorKind === "invalid-datasource"`.
// Mirrors AuthErrorBanner's lifecycle (`useConsentSession` → spinner +
// disabled-state while pending, terminal-state inline error on
// cancelled/failed/timeout). Adds a Remove action that opens the shared
// <ConfirmRemoveDatasourceDialog> before dispatching the IPC, per
// design.md Decision 5 (one shared destructive flow).
function InvalidDatasourceBanner({
  providerId,
  datasourceId,
}: {
  providerId: string;
  datasourceId: string;
}) {
  const actions = useDatasourceActions();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionState = useConsentSession(sessionId ?? "__none__");
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

  const handleReconnect = useCallback(async () => {
    const res = await window.api.datasources.startConsent({
      providerId,
      datasourceId,
    });
    setSessionId(res.sessionId);
  }, [providerId, datasourceId]);

  const handleRequestRemove = useCallback(() => {
    setRemoveDialogOpen(true);
  }, []);

  const handleCancelRemove = useCallback(() => {
    setRemoveDialogOpen(false);
  }, []);

  const handleConfirmRemove = useCallback(() => {
    setRemoveDialogOpen(false);
    void actions.remove({ datasourceId });
  }, [actions, datasourceId]);

  const isWaiting =
    sessionId !== null && sessionState.status === "pending";
  const isFailed =
    sessionId !== null &&
    (sessionState.status === "cancelled" ||
      sessionState.status === "failed" ||
      sessionState.status === "timeout");

  return (
    <>
      <div
        data-testid="invalid-datasource-banner"
        aria-label="Reconfiguration required"
        className="flex items-center justify-between gap-2"
      >
        <p className="text-destructive text-xs">
          {isFailed
            ? "Reconnect failed — please try again."
            : "Datasource needs reconfiguring — credentials are missing or invalid."}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isWaiting}
            onClick={() => {
              void handleReconnect();
            }}
          >
            {isWaiting ? "Connecting…" : "Reconnect"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="text-destructive"
            disabled={isWaiting}
            onClick={handleRequestRemove}
          >
            Remove
          </Button>
        </div>
      </div>
      <ConfirmRemoveDatasourceDialog
        open={removeDialogOpen}
        onConfirm={handleConfirmRemove}
        onCancel={handleCancelRemove}
      />
    </>
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
  status: CardDisplayStatus;
  errorReason?: string;
}) {
  const variant = statusBadgeVariant(status);
  const accessibleName = useMemo(() => {
    if (status === "error" && errorReason) {
      return `Status: error — ${errorReason}`;
    }
    if (status === "waiting-network") {
      return "Status: waiting for network";
    }
    return `Status: ${status}`;
  }, [status, errorReason]);

  // Decision 13 "Visual variant — waiting-network": the badge stays the
  // syncing variant (default) but the dot's `currentColor` swaps from
  // amber to zinc, and a `wifi-off` glyph sits left of the text. The
  // zinc colour comes from `text-zinc-400` on the badge root so the
  // SyncingDot's `fill-current` paints zinc; the badge gains
  // `aria-live="polite"` so AT announces the status change (per Decision
  // 13, no separate sibling region required).
  const isWaitingNetwork = status === "waiting-network";
  const isSyncingFamily = status === "syncing" || isWaitingNetwork;
  const label = isWaitingNetwork ? "Waiting for network" : status;

  // `aria-live="polite"` is set unconditionally — Decision 13 requires the
  // announcement on the waiting-network status change specifically, and the
  // polite-region behaviour is a strict superset (announces on any
  // text-content change, not just this one). Do NOT condition it on
  // `isWaitingNetwork` — toggling `aria-live` across renders is a known AT
  // footgun (the region must exist before the change to announce reliably).
  return (
    <Badge
      data-testid="datasource-status"
      variant={variant}
      aria-label={accessibleName}
      aria-live="polite"
      className={cn(
        "shrink-0 gap-1.5",
        isWaitingNetwork && "text-zinc-400",
      )}
    >
      {isSyncingFamily ? <SyncingDot /> : null}
      {isWaitingNetwork ? (
        <Icon
          name="wifi-off"
          data-testid="datasource-waiting-network-icon"
          data-icon="wifi-off"
          aria-hidden
          className="size-3 shrink-0"
        />
      ) : null}
      <span className="capitalize">{label}</span>
    </Badge>
  );
}

function statusBadgeVariant(
  status: CardDisplayStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "connected":
      return "secondary";
    case "syncing":
      return "default";
    case "waiting-network":
      // Decision 13: status pill stays the syncing variant.
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
// Motion (Motion-Safe-toggle phase):
//   - the inner solid dot carries bare `animate-sync-pulse` (gentle
//     opacity breathing);
//   - the outer ring carries bare `animate-sync-ripple` (expanding
//     scale + fade-out), needing `transform-origin: center` +
//     `transform-box: fill-box` so the scale transform pivots around
//     the ring's centre inside the SVG coordinate system.
// The `motion-safe:` prefix was stripped so custom animations run regardless
// of OS `prefers-reduced-motion`. Users who want OS-respectful behaviour
// enable Motion Safe via the Settings dialog — that sets `data-motion="safe"`
// on <html> and the override rule in globals.css disables these animations
// when the OS also signals reduce-motion. See features/settings/motion-store.ts.
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
        className={cn("animate-sync-ripple")}
        style={{ transformOrigin: "center", transformBox: "fill-box" }}
      />
      {/* Solid dot with the existing gentle pulse breathing. */}
      <circle
        cx="12"
        cy="12"
        r="4"
        className={cn("animate-sync-pulse")}
        style={{ transformOrigin: "center", transformBox: "fill-box" }}
      />
    </svg>
  );
}

interface QuickActionsMenuProps {
  pauseLabel: string;
  onExplore: () => void;
  onSyncNow: () => void;
  onPauseOrResume: () => void;
  onUpload: () => void;
  onRemove: () => void;
}

function QuickActionsMenu({
  pauseLabel,
  onExplore,
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
        {/* ui-file-explorer (task 8.2): Explore is the primary navigation
            entry to the file-explorer view for this datasource. It sits at
            index 0 per the spec delta — users reach for the browse action
            most often, so it leads the menu. */}
        <DropdownMenuItem onSelect={onExplore}>
          <Icon name="folder-open" className="size-4" aria-hidden />
          Explore
        </DropdownMenuItem>
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
