"use client";

//
// SettingsDialog — the app-level Settings modal triggered by the header's
// Settings button. Sections, top-down (General → Browsing → File-handling):
//
//   1. **Motion** — Motion Safe switch driving the `motion-store`
//      preference. Default (always-on) = switch OFF; toggling on writes
//      `safe` to localStorage and sets `data-motion="safe"` on <html>,
//      which activates the CSS override in globals.css.
//   2. **Explorer** (add-engine-listdirectory-pagination §12 / Visual
//      direction V-4) — "Items loaded per page" page-size dropdown. A
//      `DropdownMenu` + `DropdownMenuRadioGroup` (mirroring the toolbar
//      View-mode menu — the codebase intentionally has no shadcn `Select`)
//      writes one of 100 / 500 / 1000 / 5000 / 10000 to the store's
//      `EXPLORER_PAGE_SIZE_KEY` as an un-formatted integer string. Default
//      display 500 on first read (via the store's `readExplorerPageSize`).
//      The file-explorer store re-reads the key on every `files:list`
//      origination, so changing the value here does NOT auto-refresh the
//      current view — it applies to the next list call.
//   3. **Downloads** (add-engine-rename-download §22) — default folder
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

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/icon";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import {
  EXPLORER_PAGE_SIZE_KEY,
  readExplorerPageSize,
} from "../file-explorer/store";

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

// Page-size choices (add-engine-listdirectory-pagination Decision 3).
// `value` is the un-formatted integer string persisted to localStorage and
// fed to `DropdownMenuRadioGroup`; `label` is the display text with comma
// separators on values >= 1000. Mirrors the toolbar View-menu `OPTIONS`
// pattern so the trigger text and the radio items derive from one source.
// We hardcode the label rather than `Number.toLocaleString()` because the
// latter is locale-dependent in Node/CI and could emit a non-comma
// separator, making the trigger assertion flaky.
const PAGE_SIZE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "100", label: "100" },
  { value: "500", label: "500" },
  { value: "1000", label: "1,000" },
  { value: "5000", label: "5,000" },
  { value: "10000", label: "10,000" },
];

// Resolve the display label for an integer page size. Falls back to a
// locale-free thousands-grouped string for any value not in the fixed
// option set (e.g. a hand-edited localStorage key holding 2000) so the
// trigger never renders a bare token like "2000" inconsistently with the
// menu's comma style.
function pageSizeLabel(value: number): string {
  const match = PAGE_SIZE_OPTIONS.find((o) => o.value === String(value));
  if (match !== undefined) return match.label;
  return value.toLocaleString("en-US");
}

// Persist the selected page size to the store's localStorage key as an
// un-formatted integer string. Guarded + SSR-safe, mirroring the store's
// `readExplorerPageSize` read and `downloads-store`'s write. Best-effort:
// a storage-quota/sandbox throw is swallowed; the in-memory React state
// still reflects the user's choice for this session.
function writeExplorerPageSize(value: string): void {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(EXPLORER_PAGE_SIZE_KEY, value);
  } catch {
    // Storage quota / sandbox — best-effort.
  }
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

  // Page-size preference. Seeded once from the store's localStorage read
  // helper (default 500). Local React state — not the `useSyncExternalStore`
  // machinery `downloads-store` uses — because this row is the ONLY observer
  // of the key; the file-explorer store re-reads localStorage directly on
  // each list call rather than subscribing. `String(...)` keys the radio
  // group on the un-formatted integer string the options use.
  const [pageSize, setPageSize] = useState<string>(() =>
    String(readExplorerPageSize()),
  );

  const handlePageSizeChange = useCallback((next: string) => {
    setPageSize(next);
    writeExplorerPageSize(next);
  }, []);

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

        {/*
          Explorer section (add-engine-listdirectory-pagination §12 / Visual
          direction V-4). Sits between Motion and Downloads. One row mirroring
          Downloads' "Default folder" flex layout: a left text stack
          (label + description) and a right-aligned page-size dropdown.

          The trigger carries `aria-label="Items loaded per page"` so the
          control is announced before the menu opens (the visible text is just
          the current numeric value). The `DropdownMenuRadioGroup` value is the
          un-formatted integer string; Radix supplies `role="menuitemradio"` +
          `aria-checked` and full keyboard nav, so the spec's
          keyboard-reachable / active-value scenarios are satisfied without
          hand-rolled ARIA.
        */}
        <section
          aria-labelledby="settings-explorer-heading"
          className="flex flex-col gap-3"
        >
          <h3
            id="settings-explorer-heading"
            className="text-sm font-semibold"
          >
            Explorer
          </h3>

          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs font-medium">Items loaded per page</span>
              <span className="text-muted-foreground text-xs">
                Larger values fetch more per click; smaller values paint faster
                on first load.
              </span>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Items loaded per page"
                  className="shrink-0"
                >
                  <span className="tabular-nums">
                    {pageSizeLabel(Number(pageSize))}
                  </span>
                  <Icon name="chevron-down" className="size-3" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="text-muted-foreground text-xs uppercase tracking-wider">
                  Page size
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={pageSize}
                  onValueChange={handlePageSizeChange}
                >
                  {PAGE_SIZE_OPTIONS.map((opt) => (
                    <DropdownMenuRadioItem
                      key={opt.value}
                      value={opt.value}
                      className="tabular-nums"
                    >
                      {opt.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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
