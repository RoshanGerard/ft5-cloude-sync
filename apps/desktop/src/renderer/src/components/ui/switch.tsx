import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// shadcn/ui v4 `switch` primitive — stock shape, ported to use the
// `radix-ui` umbrella package already on disk (rather than pulling in
// @radix-ui/react-switch directly). Mirrors the pattern used by
// `dialog.tsx` and `dropdown-menu.tsx` in this repo.
//
// Surface: <Switch /> is a controlled toggle with a sliding thumb. Used in
// the Settings dialog (Motion Safe) — see
// features/settings/settings-dialog.tsx.

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background ring-0 shadow-lg transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
