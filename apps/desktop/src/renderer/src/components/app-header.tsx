"use client";

// AppHeader — Decision 14 (review-round-1). Persistent brand chrome at the
// top of the renderer. Mounted once in the RootLayout so it stays put across
// any future routes. Three elements, nothing else:
//
//   [logo] FT5 Unified Cloud Sync                        [ThemeSwitcher]
//
// Layout: 48px tall flex row, hairline bottom border. Left slot holds the
// logo + wordmark; right slot holds the theme switcher (which was previously
// in the dashboard toolbar). This matches the Linear/Vercel convention of
// putting app-level settings in the global chrome and reserving page-level
// toolbars for page actions.

import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";
import { Forti5Logo } from "@/components/forti5-logo";
import { ThemeSwitcher } from "@/features/theme/theme-switcher";

export type AppHeaderProps = HTMLAttributes<HTMLElement>;

export function AppHeader({ className, ...rest }: AppHeaderProps) {
  return (
    <header
      className={cn(
        "flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4",
        className,
      )}
      {...rest}
    >
      <div className="flex items-center gap-2">
        <Forti5Logo size={28} />
        <span className="text-sm font-medium">FT5 Unified Cloud Sync</span>
      </div>
      <ThemeSwitcher />
    </header>
  );
}
