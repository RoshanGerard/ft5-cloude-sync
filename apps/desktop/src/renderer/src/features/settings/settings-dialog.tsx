"use client";

//
// SettingsDialog — the app-level Settings modal triggered by the header's
// Settings button. Two sections in this phase:
//
//   1. **Motion** — Motion Safe switch driving the `motion-store`
//      preference. Default (always-on) = switch OFF; toggling on writes
//      `safe` to localStorage and sets `data-motion="safe"` on <html>,
//      which activates the CSS override in globals.css.
//   2. **Downloads** (add-engine-rename-download §22) — default folder
//      row (path display + Open + Change…) plus an "Always ask where to
//      save" Switch. Default folder defaults to "Not set" until the user
//      either commits the first-run modal (§21) or picks via Change….
//      Open dispatches `window.api.files.showSavedInFolder(folder)`.
//      Change… dispatches `window.api.dialog.showOpenDialog` with
//      `properties: ['openDirectory', 'createDirectory']`. Always-ask
//      writes `"yes"` to `ft5.downloads.alwaysAsk`; toggling off
//      removes the key.
//
// Dialog focus-restoration mirrors AddDatasourceDialog: the parent passes
// the element that opened the dialog via `returnFocusTo`, and
// `onCloseAutoFocus` redirects focus back. Radix's default focus
// restoration is unreliable in jsdom when the trigger click path didn't
// actually focus the button.
//
// Filename note: the radii-ceiling guardrail permits `rounded-lg` only on
// files whose basename contains `dialog` — `settings-dialog.tsx`
// qualifies.

import { useCallback } from "react";

import { Button } from "@/components/ui/button";
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
  setAlwaysAsk,
  setDefaultFolder,
  useAlwaysAsk,
  useDefaultFolder,
} from "./downloads-store";
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
  const defaultFolder = useDefaultFolder();
  const alwaysAsk = useAlwaysAsk();

  const handleToggleMotionSafe = useCallback((checked: boolean) => {
    const next: MotionPreference = checked ? "safe" : "always-on";
    setPreference(next);
  }, []);

  const handleOpenFolder = useCallback(() => {
    if (defaultFolder === null) return;
    const bridge = (
      globalThis as unknown as {
        window?: {
          api?: {
            files?: {
              showSavedInFolder?: (path: string) => Promise<void>;
            };
          };
        };
      }
    ).window?.api?.files?.showSavedInFolder;
    if (typeof bridge === "function") {
      void bridge(defaultFolder);
    }
  }, [defaultFolder]);

  const handleChangeFolder = useCallback(async () => {
    const bridge = (
      globalThis as unknown as {
        window?: {
          api?: {
            dialog?: {
              showOpenDialog?: (opts: {
                title?: string;
                defaultPath?: string;
                properties?: readonly string[];
              }) => Promise<{
                canceled: boolean;
                filePaths: readonly string[];
              }>;
            };
          };
        };
      }
    ).window?.api?.dialog?.showOpenDialog;
    if (typeof bridge !== "function") return;

    const result = await bridge({
      title: "Choose downloads folder",
      ...(defaultFolder !== null ? { defaultPath: defaultFolder } : {}),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return;
    const picked = result.filePaths[0];
    if (picked !== undefined && picked.length > 0) {
      setDefaultFolder(picked);
    }
  }, [defaultFolder]);

  const handleToggleAlwaysAsk = useCallback((checked: boolean) => {
    setAlwaysAsk(checked);
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

        <section
          aria-labelledby="settings-motion-heading"
          className="flex flex-col gap-3"
        >
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

        <section
          aria-labelledby="settings-downloads-heading"
          className="flex flex-col gap-3"
        >
          <h3
            id="settings-downloads-heading"
            className="text-sm font-semibold"
          >
            Downloads
          </h3>

          {/*
            Default folder row. Path display truncates with ellipsis on
            long paths (the inner span uses `truncate`); the outer flex
            row keeps Open + Change buttons right-aligned. Open is
            disabled when no path is stored — there's nothing to reveal,
            and `shell.showItemInFolder("")` would either no-op or throw
            depending on platform.
          */}
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs font-medium">Default folder</span>
              <span
                className="text-muted-foreground truncate text-xs"
                title={defaultFolder ?? undefined}
              >
                {defaultFolder ?? "Not set"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleOpenFolder}
                disabled={defaultFolder === null}
              >
                Open
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleChangeFolder}
              >
                Change&hellip;
              </Button>
            </div>
          </div>

          {/* Always-ask Switch row. Label wraps the entire row's text
              copy via htmlFor so the label-click activation matches the
              Motion section's pattern. */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="downloads-always-ask-toggle"
                className="text-xs font-medium"
              >
                Always ask where to save
              </Label>
              <p className="text-muted-foreground text-xs">
                Show the Save-as dialog for every download.
              </p>
            </div>
            <Switch
              id="downloads-always-ask-toggle"
              aria-label="Always ask where to save"
              checked={alwaysAsk}
              onCheckedChange={handleToggleAlwaysAsk}
            />
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
