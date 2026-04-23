import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn(
        // Review-round-3, Task 3: swapped `bg-primary/20` → `bg-muted`. On
        // the dark theme `--primary` is near-white (oklch 0.929), so 20%
        // white over a dark canvas read as a too-bright track ("secondary
        // white color on progress bar is too bright" — user review-round-3).
        // `bg-muted` is a single theme-scoped token that reads as a
        // subdued-but-visible track on every theme (light / dark / serene-
        // blue) without opacity layering.
        "relative h-2 w-full overflow-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
