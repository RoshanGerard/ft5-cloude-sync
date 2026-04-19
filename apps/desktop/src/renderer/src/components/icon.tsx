"use client"

/**
 * Icon adapter — the ONE place in renderer feature code that imports from
 * `lucide-react`. The scripts/lucide-react-forbidden-import.test.ts guardrail
 * enforces that every other feature-code `.tsx` must go through this module.
 *
 * Phase 5.4 extends the IconName union to cover the provider-icon strings
 * carried by the frozen `providers` registry in @ft5/ipc-contracts:
 *   - google-drive → "cloud"
 *   - onedrive     → "cloud"
 *   - amazon-s3    → "database"
 * Plus a `hard-drive` alias that's commonly useful for future
 * local-filesystem-backed datasources.
 *
 * The theme-switcher retains its sun/moon/monitor/laptop set.
 */

import {
  CloudIcon,
  DatabaseIcon,
  DropletsIcon,
  FolderSyncIcon,
  HardDriveIcon,
  LaptopIcon,
  MonitorIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
  type LucideProps,
} from "lucide-react"
import type { ComponentType } from "react"

export type IconName =
  | "sun"
  | "moon"
  | "monitor"
  | "laptop"
  | "cloud"
  | "database"
  | "hard-drive"
  // Decision 15 (review-round-1): primary-CTA glyphs. Every primary call-to-
  // action renders icon+label; extending the IconName union is the only
  // place this is reflected in the adapter API.
  | "plus"
  | "refresh-cw"
  | "pause"
  | "play"
  | "upload"
  | "settings"
  | "trash-2"
  // Review-round-3:
  //   `folder-sync` — leading glyph on the dashboard "Datasources" title
  //     (Task 4: modernize heading with a complementary glyph).
  //   `droplets`    — Serene Blue theme-switcher option indicator (Task 6c).
  | "folder-sync"
  | "droplets"

const REGISTRY: Record<IconName, ComponentType<LucideProps>> = {
  sun: SunIcon,
  moon: MoonIcon,
  monitor: MonitorIcon,
  laptop: LaptopIcon,
  cloud: CloudIcon,
  database: DatabaseIcon,
  "hard-drive": HardDriveIcon,
  plus: PlusIcon,
  "refresh-cw": RefreshCwIcon,
  pause: PauseIcon,
  play: PlayIcon,
  upload: UploadIcon,
  settings: SettingsIcon,
  "trash-2": Trash2Icon,
  "folder-sync": FolderSyncIcon,
  droplets: DropletsIcon,
}

// Every name registered in the adapter. Consumers that need to validate a
// runtime string against the IconName union (e.g. a provider descriptor's
// icon field) should import this rather than duplicating a static array —
// that decoupling avoids the "adapter grew a name but downstream allowlist
// didn't" drift flagged in code review I-2 (review-round-1).
export const ICON_NAMES = Object.keys(REGISTRY) as readonly IconName[]

export function isIconName(value: string): value is IconName {
  return (ICON_NAMES as readonly string[]).includes(value)
}

export type IconProps = {
  name: IconName
} & Omit<LucideProps, "ref">

export function Icon({ name, ...rest }: IconProps) {
  const Component = REGISTRY[name]
  return <Component {...rest} />
}
