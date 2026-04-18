"use client"

/**
 * Icon adapter — the ONE place in renderer feature code that imports from
 * `lucide-react`. Phase 4C expands the `IconName` union to cover every icon
 * used in the app and adds an ESLint rule banning `lucide-react` imports
 * outside this file (and `components/ui/**` where shadcn-generated code
 * legitimately uses it).
 *
 * For Phase 4B we only need the three theme-switcher icons plus a `laptop`
 * alias — keep the surface area minimal and let Phase 4C extend it.
 */

import {
  LaptopIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  type LucideProps,
} from "lucide-react"
import type { ComponentType } from "react"

export type IconName = "sun" | "moon" | "monitor" | "laptop"

const REGISTRY: Record<IconName, ComponentType<LucideProps>> = {
  sun: SunIcon,
  moon: MoonIcon,
  monitor: MonitorIcon,
  laptop: LaptopIcon,
}

export type IconProps = {
  name: IconName
} & Omit<LucideProps, "ref">

export function Icon({ name, ...rest }: IconProps) {
  const Component = REGISTRY[name]
  return <Component {...rest} />
}
