"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { usePreference } from "@/features/theme/theme-store"

// design.md Decision 6 rejects next-themes; this wrapper reads the renderer's
// own theme store so Sonner reflects the user's explicit Light/Dark choice
// (falling back to `prefers-color-scheme` when the preference is "system").
//
// Review-round-3, Task 6: Sonner's `theme` prop only accepts
// `"light" | "dark" | "system"`. Our preference union now includes
// `"serene-blue"` (a light-mode alternative); map it to `"light"` when
// forwarding to Sonner — the toast chrome inherits the correct colour
// tokens through CSS variables (`--normal-bg` → `var(--popover)`, etc.)
// so Sonner doesn't need to know the custom theme name exists.
const Toaster = ({ ...props }: ToasterProps) => {
  const pref = usePreference()
  const theme: ToasterProps["theme"] =
    pref === "serene-blue" ? "light" : pref

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
