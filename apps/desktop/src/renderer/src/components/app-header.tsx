"use client";

// AppHeader — Decision 14 (review-round-1) extended by the Motion Safe phase.
// Persistent brand chrome at the top of the renderer. Mounted once in the
// RootLayout so it stays put across any future routes. Elements:
//
//   [logo] FT5 Unified Cloud Sync              [settings] [ThemeSwitcher]
//
// Settings button opens the SettingsDialog (Motion Safe toggle). Sits
// BEFORE the ThemeSwitcher in DOM order so the visual reading is
// settings-then-theme, left-to-right. Ghost/icon variant matches the
// ThemeSwitcher trigger for visual consistency across chrome affordances.
//
// Dialog open-state is lifted to this component; the Settings button click
// captures its own `currentTarget` so focus can be restored to it on close
// (Radix's default restoration is unreliable in jsdom without an explicit
// returnFocusTo — same pattern as AddDatasourceDialog in the datasources
// feature).

import { useCallback, useRef, useState, type HTMLAttributes } from "react";

import { cn } from "@/lib/utils";
import { Forti5Logo } from "@/components/forti5-logo";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icon";
import { ThemeSwitcher } from "@/features/theme/theme-switcher";
import { SettingsDialog } from "@/features/settings/settings-dialog";

export type AppHeaderProps = HTMLAttributes<HTMLElement>;

export function AppHeader({ className, ...rest }: AppHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Track the element that opened the dialog so we can restore focus
  // explicitly on close. Ref rather than state — a rerender on every click
  // is pointless.
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

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
      <div className="flex items-center gap-1">
        <Button
          ref={settingsTriggerRef}
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Open settings"
          onClick={handleOpenSettings}
        >
          <Icon name="settings" className="size-4" aria-hidden />
          <span className="sr-only">Open settings</span>
        </Button>
        <ThemeSwitcher />
      </div>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        returnFocusTo={settingsTriggerRef.current}
      />
    </header>
  );
}
