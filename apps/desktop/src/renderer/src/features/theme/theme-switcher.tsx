"use client"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Icon, type IconName } from "@/components/icon"

import {
  setPreference,
  usePreference,
  type ThemePreference,
} from "./theme-store"

/**
 * User-facing theme picker — Light / Dark / System.
 *
 * Trigger shows an icon that reflects the *current preference* (not the
 * resolved effective theme): sun for Light, moon for Dark, monitor for
 * System. The effective (light|dark) theme is applied via the theme store
 * and picked up by the inline pre-paint script on cold start plus any
 * subscriber (e.g. the sonner Toaster) on warm update.
 */

const OPTIONS: ReadonlyArray<{
  value: ThemePreference
  label: string
  icon: IconName
}> = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
]

function iconForPreference(pref: ThemePreference): IconName {
  switch (pref) {
    case "light":
      return "sun"
    case "dark":
      return "moon"
    case "system":
      return "monitor"
  }
}

export function ThemeSwitcher() {
  const preference = usePreference()
  const indicator = iconForPreference(preference)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Toggle theme">
          <Icon
            name={indicator}
            data-testid="theme-indicator"
            data-icon={indicator}
            className="size-4"
            aria-hidden
          />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onSelect={() => setPreference(opt.value)}
          >
            <Icon name={opt.icon} className="size-4" aria-hidden />
            <span>{opt.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
