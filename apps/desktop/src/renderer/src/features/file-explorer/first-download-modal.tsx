"use client";

//
// add-engine-rename-download §21 — first-run downloads modal.
//
// Shown on the user's first-ever Download click (detected by absence
// of `ft5.downloads.defaultFolder` in localStorage). Collects the
// default downloads folder, persists it via `setDefaultFolder` (which
// writes the localStorage key + mirrors into the main-process slot
// per §20), and signals the deferred download trigger via the
// `onCommit(folder)` callback.
//
// Per design.md V3 + spec.md § "First-run downloads modal collects
// the default folder", the modal is BLOCKING: Escape, backdrop click,
// and the X close affordance are all suppressed. The only path that
// closes it is the primary "Use this folder" CTA. This is enforced
// at three layers:
//   - `onEscapeKeyDown.preventDefault()` blocks the Escape path.
//   - `onPointerDownOutside.preventDefault()` blocks backdrop clicks.
//   - `showCloseButton={false}` removes the shadcn Dialog's X icon.
// `onOpenChange` from Radix still fires `false` only via the Escape
// or pointer-outside paths (the X close button is gone), and both
// paths are pre-empted by the preventDefault calls above. The
// implementation passes `onOpenChange` through unchanged — callers
// that care about lifecycle events can subscribe, but the modal will
// not flip itself closed.
//
// Default-folder pre-fill: post-archive bug fix wires the modal to
// `app.getPath("downloads")` via the preload bridge
// (`window.api.preferences.getOSDefaultDownloadsFolder`) and appends
// `ft5` with the host's path separator. The earlier placeholder string
// `"~/Downloads/ft5"` was NOT absolute and failed the service-side
// `path.isAbsolute` validator on every host — the user could press
// "Use this folder" and every subsequent download would silently drop.
//
// Filename note: the radii-ceiling guardrail (`scripts/radii-ceiling.test.ts`)
// only exempts files whose basename contains the literal `dialog` token —
// this file's basename is `first-download-modal.tsx` (no `dialog`), so it
// cannot use the larger `lg`/`xl`/`2xl`/`3xl`/`full` rounded-* classes; the
// implementation below sticks to the default `sm`/`md` end of the scale.

import { useCallback, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { setDefaultFolder } from "../settings/downloads-store";
import { joinFolderAndName } from "./use-download-orchestrator";

export interface FirstDownloadModalProps {
  /**
   * Whether the modal is currently rendered. Controlled by the
   * orchestrator (the future §23 wiring; harnessed in §21.3 tests).
   */
  open: boolean;
  /**
   * Invoked with the chosen folder after the user clicks
   * "Use this folder". The folder has already been persisted via
   * `setDefaultFolder` at this point; the callback exists so the
   * orchestrator can flush the deferred download.
   */
  onCommit: (folder: string) => void;
  /**
   * Optional pass-through to Radix's `Dialog.onOpenChange`. The modal
   * itself will not flip open → false except via the commit path; this
   * prop exists for parity with other dialogs in the codebase. Any
   * `false` arg here would have to come from a future code path that
   * forces the dialog closed (none exists today).
   */
  onOpenChange?: (open: boolean) => void;
}

export function FirstDownloadModal({
  open,
  onCommit,
  onOpenChange,
}: FirstDownloadModalProps) {
  // The pre-fill is resolved asynchronously via the preload bridge
  // (`app.getPath("downloads")`), so the input starts empty and the
  // commit CTA is disabled until either resolution completes or the
  // user types / picks a folder. This is the post-archive bug fix:
  // gating the CTA on a non-empty value prevents the user from
  // committing the previous `"~/Downloads/ft5"` placeholder, which the
  // service-side `path.isAbsolute` validator rejected.
  const [folder, setFolder] = useState<string>("");
  const inputId = useId();
  const descId = useId();

  // Resolve the OS default downloads folder lazily on mount. We don't
  // overwrite a user-typed value: the effect only seeds the input when
  // it's still empty by the time the bridge resolves.
  useEffect(() => {
    let cancelled = false;
    const bridge = (
      globalThis as unknown as {
        window?: {
          api?: {
            preferences?: {
              getOSDefaultDownloadsFolder?: () => Promise<string>;
            };
          };
        };
      }
    ).window?.api?.preferences?.getOSDefaultDownloadsFolder;
    if (typeof bridge !== "function") return;
    void (async () => {
      try {
        const downloads = await bridge();
        if (cancelled) return;
        // Only seed if the user hasn't already typed something.
        setFolder((current) =>
          current === "" ? joinFolderAndName(downloads, "ft5") : current,
        );
      } catch {
        // Bridge failure leaves the input empty — the user can still
        // type or use Browse. Better than persisting a non-absolute
        // placeholder.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBrowse = useCallback(async () => {
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
      defaultPath: folder,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return;
    const picked = result.filePaths[0];
    if (picked !== undefined && picked.length > 0) {
      setFolder(picked);
    }
  }, [folder]);

  const handleCommit = useCallback(() => {
    if (folder === "") return;
    setDefaultFolder(folder);
    onCommit(folder);
  }, [folder, onCommit]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={descId}
        onEscapeKeyDown={(event) => {
          // Spec.md § "Modal cannot be dismissed without commit" —
          // Escape is a no-op until the user clicks the CTA.
          event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          // Backdrop clicks must not dismiss the modal.
          event.preventDefault();
        }}
        onInteractOutside={(event) => {
          // Belt-and-braces — covers the focus-out interactions Radix
          // bundles into `onInteractOutside` on top of pointer-down.
          event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Where should downloads go?</DialogTitle>
          <DialogDescription id={descId}>
            Choose a default folder. You can change this later in
            Settings or use &ldquo;Save as&hellip;&rdquo; to pick per
            file.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor={inputId} className="sr-only">
            Downloads folder
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              type="text"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              aria-label="Downloads folder"
              spellCheck={false}
              autoComplete="off"
            />
            <Button
              type="button"
              variant="outline"
              onClick={handleBrowse}
            >
              Browse&hellip;
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            onClick={handleCommit}
            disabled={folder === ""}
          >
            Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
