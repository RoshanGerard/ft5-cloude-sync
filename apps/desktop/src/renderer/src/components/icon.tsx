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
  HardDriveIcon,
  LaptopIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
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

const REGISTRY: Record<IconName, ComponentType<LucideProps>> = {
  sun: SunIcon,
  moon: MoonIcon,
  monitor: MonitorIcon,
  laptop: LaptopIcon,
  cloud: CloudIcon,
  database: DatabaseIcon,
  "hard-drive": HardDriveIcon,
}

export type IconProps = {
  name: IconName
} & Omit<LucideProps, "ref">

export function Icon({ name, ...rest }: IconProps) {
  const Component = REGISTRY[name]
  return <Component {...rest} />
}
