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
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloudIcon,
  CopyIcon,
  AlertTriangleIcon,
  DatabaseIcon,
  DropletsIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderSyncIcon,
  HardDriveIcon,
  HomeIcon,
  LaptopIcon,
  MonitorIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
  WifiOffIcon,
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
  // ui-file-explorer: breadcrumb separator (chevron-right), back/forward/up
  // navigation buttons on the explorer chrome. `home` is used as the root
  // segment's leading glyph to match the design-note that the root reads as
  // the datasource root.
  | "chevron-left"
  | "chevron-right"
  | "chevron-up"
  | "chevron-down"
  | "arrow-up"
  | "home"
  // ui-file-explorer (Phase 3, design.md Decision 8): file/folder family
  // glyphs. `iconForEntry` in features/file-explorer/icons.ts is the single
  // place that maps (kind, mimeFamily) → one of these names; feature code
  // never names a lucide icon directly.
  //
  // Lucide 1.8.0 exports all nine under the expected *Icon suffix — no
  // rename substitutions were required.
  | "folder"
  | "folder-open"
  | "file"
  | "file-image"
  | "file-video"
  | "file-audio"
  | "file-text"
  | "file-archive"
  | "file-code"
  // ui-file-explorer Phase 5 — Properties modal's per-field copy-to-clipboard
  // affordance (FieldRowWithCopy in features/file-explorer/metadata).
  | "copy"
  // ui-file-explorer Phase 6.11 — error-pin glyph on rows whose last op failed.
  | "alert-triangle"
  // ui-file-explorer Phase 7.2 — toolbar Search trigger glyph.
  | "search"
  // wire-fs-sync-service Phase 10.8 — waiting-network badge variant uses
  // `wifi-off` left of the status text to make the cause legible at a
  // glance (Decision 13's "Visual variant — waiting-network").
  | "wifi-off"

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
  "chevron-left": ChevronLeftIcon,
  "chevron-right": ChevronRightIcon,
  "chevron-up": ChevronUpIcon,
  "chevron-down": ChevronDownIcon,
  "arrow-up": ArrowUpIcon,
  home: HomeIcon,
  folder: FolderIcon,
  "folder-open": FolderOpenIcon,
  file: FileIcon,
  "file-image": FileImageIcon,
  "file-video": FileVideoIcon,
  "file-audio": FileAudioIcon,
  "file-text": FileTextIcon,
  "file-archive": FileArchiveIcon,
  "file-code": FileCodeIcon,
  copy: CopyIcon,
  "alert-triangle": AlertTriangleIcon,
  search: SearchIcon,
  "wifi-off": WifiOffIcon,
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
