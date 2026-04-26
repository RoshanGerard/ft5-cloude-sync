"use client";

//
// DropOverlay — stateless presentation component for the file-explorer
// drop surface.
//
// Two variants selected via a discriminant prop:
//   - "active"  : amber dashed border + translucent tint + Upload icon +
//                 "Drop to upload here" headline + "→ /<targetDir>" subtext.
//   - "blocked" : neutral palette, state-specific icon (cloud-off /
//                 key-round / refresh-cw with `animate-sync-pulse`),
//                 headline "Can't upload right now", body varies by reason.
//
// Motion budget: the spinning icon in the "syncing" blocked variant uses
// `animate-sync-pulse` (the project's single approved pulse utility) rather
// than the standard Tailwind spin utility — see
// openspec/changes/archive/2026-04-21-ui-file-explorer/file-explorer.md motion
// notes and the SyncingState component for the sibling pattern.
//
// Accessibility:
//   - role="status" + aria-live="polite" so screen readers announce the
//     overlay appearing (matches design.md § Visual direction).
//   - Every icon is aria-hidden; the text nodes carry the accessible name.
//   - `pointer-events-none` on the overlay so drag events continue to
//     bubble to the wrapping DropZone's handlers.

import type { ReactElement } from "react";

import { Icon } from "@/components/icon";

import type { IconName } from "../../components/icon";

export type DropOverlayBlockedReason =
  | "disconnected"
  | "auth-revoked"
  | "syncing";

export type DropOverlayProps =
  | { kind: "active"; targetDir: string }
  | { kind: "blocked"; blockedReason: DropOverlayBlockedReason };

interface BlockedCopy {
  readonly icon: IconName;
  readonly body: string;
  /**
   * Additional className applied to the icon. Only the syncing variant
   * uses this (for `animate-sync-pulse`); others pass through unstyled.
   */
  readonly iconClassName?: string;
}

const BLOCKED_COPY: Record<DropOverlayBlockedReason, BlockedCopy> = {
  disconnected: {
    icon: "cloud-off",
    body: "This datasource is disconnected",
  },
  "auth-revoked": {
    icon: "key-round",
    body: "This datasource needs you to sign in again",
  },
  syncing: {
    icon: "refresh-cw",
    body: "This datasource is still indexing — try again in a moment",
    iconClassName: "animate-sync-pulse",
  },
};

export function DropOverlay(props: DropOverlayProps): ReactElement {
  if (props.kind === "active") {
    return (
      <div
        data-testid="drop-overlay-active"
        role="status"
        aria-live="polite"
        className="pointer-events-none absolute inset-1 z-10 flex flex-col items-center justify-center gap-[10px] rounded-md border-2 border-dashed border-amber-600 bg-amber-600/8"
      >
        <Icon
          name="upload"
          className="text-amber-600"
          width={40}
          height={40}
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <div className="text-[15px] font-semibold text-amber-700">
          Drop to upload here
        </div>
        <div className="text-[13px] font-normal text-amber-600">
          {`→ ${props.targetDir}`}
        </div>
      </div>
    );
  }

  const copy = BLOCKED_COPY[props.blockedReason];
  return (
    <div
      data-testid="drop-overlay-blocked"
      data-blocked-reason={props.blockedReason}
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-1 z-10 flex flex-col items-center justify-center gap-[10px] rounded-md border-2 border-dashed border-muted-foreground"
    >
      <Icon
        name={copy.icon}
        className={`text-muted-foreground${copy.iconClassName ? ` ${copy.iconClassName}` : ""}`}
        width={40}
        height={40}
        strokeWidth={1.5}
        aria-hidden="true"
      />
      <div className="text-[15px] font-semibold text-foreground">
        Can&apos;t upload right now
      </div>
      <div className="max-w-[320px] text-center text-[13px] font-normal text-muted-foreground">
        {copy.body}
      </div>
    </div>
  );
}
