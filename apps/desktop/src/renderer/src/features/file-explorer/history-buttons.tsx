"use client";

import { useSyncExternalStore } from "react";

import { Icon, type IconName } from "@/components/icon";

import type { ExplorerStore } from "./store.js";

/**
 * HistoryButtons — Back / Forward / Up-one-level controls for the explorer
 * chrome. Three icon-only native <button> elements wired to the passed-in
 * store's `back`, `forward`, and `up` actions. Enabled state is derived
 * directly from the store state each render:
 *
 *   - canBack    = history.index > 0
 *   - canForward = history.index < history.stack.length - 1
 *   - canUp      = currentPath !== "/"
 *
 * The native `disabled` attribute keeps Enter / Space / click suppression
 * consistent with browser button semantics — no extra keyboard handlers
 * needed.
 */

export interface HistoryButtonsProps {
  store: ExplorerStore;
}

interface ButtonDef {
  label: string;
  icon: IconName;
  onClick: () => void;
  disabled: boolean;
}

export function HistoryButtons({ store }: HistoryButtonsProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  const canBack = state.history.index > 0;
  const canForward = state.history.index < state.history.stack.length - 1;
  const canUp = state.currentPath !== "/";

  const buttons: ButtonDef[] = [
    {
      label: "Go back",
      icon: "chevron-left",
      onClick: () => store.back(),
      disabled: !canBack,
    },
    {
      label: "Go forward",
      icon: "chevron-right",
      onClick: () => store.forward(),
      disabled: !canForward,
    },
    {
      label: "Go up one level",
      icon: "arrow-up",
      onClick: () => store.up(),
      disabled: !canUp,
    },
  ];

  return (
    <div className="flex items-center gap-1">
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          aria-label={b.label}
          onClick={b.onClick}
          disabled={b.disabled}
          className="text-muted-foreground hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 inline-flex size-8 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50"
        >
          <Icon name={b.icon} className="size-4" aria-hidden />
        </button>
      ))}
    </div>
  );
}
