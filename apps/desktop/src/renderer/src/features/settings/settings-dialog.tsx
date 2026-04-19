"use client";

//
// SettingsDialog — the app-level Settings modal triggered by the header's
// Settings button. First and only section in this phase: **Motion**. Hosts a
// Switch that drives the `motion-store` preference. Motion Safe OFF (default)
// = custom animations always run; Motion Safe ON = when the OS signals
// reduce-motion, the three custom animations are disabled via a CSS override
// in globals.css.
//
// Dialog focus-restoration mirrors AddDatasourceDialog: the parent passes the
// element that opened the dialog via `returnFocusTo`, and `onCloseAutoFocus`
// redirects focus back. Radix's default focus restoration is unreliable in
// jsdom when the trigger click path didn't actually focus the button.
//
// Filename note: the radii-ceiling guardrail permits `rounded-lg` only on
// files whose basename contains `dialog` — `settings-dialog.tsx` qualifies.

import { useCallback } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import {
  setPreference,
  useMotionPreference,
  type MotionPreference,
} from "./motion-store";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Element to restore focus to when the dialog closes. Typically the
   * header Settings button. Same pattern as AddDatasourceDialog.
   */
  returnFocusTo?: HTMLElement | null;
}

export function SettingsDialog({
  open,
  onOpenChange,
  returnFocusTo,
}: SettingsDialogProps) {
  const preference = useMotionPreference();
  const motionSafeOn = preference === "safe";

  const handleToggleMotionSafe = useCallback((checked: boolean) => {
    const next: MotionPreference = checked ? "safe" : "always-on";
    setPreference(next);
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby="settings-dialog-description"
        onCloseAutoFocus={(event) => {
          if (returnFocusTo && returnFocusTo.isConnected) {
            event.preventDefault();
            returnFocusTo.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription id="settings-dialog-description">
            Manage app-level preferences.
          </DialogDescription>
        </DialogHeader>

        <section aria-labelledby="settings-motion-heading" className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h3
                id="settings-motion-heading"
                className="text-sm font-semibold"
              >
                Motion
              </h3>
              <Label
                htmlFor="motion-safe-toggle"
                className="text-muted-foreground text-xs font-normal"
              >
                Motion Safe
              </Label>
            </div>
            <Switch
              id="motion-safe-toggle"
              aria-label="Motion Safe"
              checked={motionSafeOn}
              onCheckedChange={handleToggleMotionSafe}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            When on, custom animations respect your system&rsquo;s reduce-motion
            setting. When off (default), animations always run.
          </p>
        </section>
      </DialogContent>
    </Dialog>
  );
}
