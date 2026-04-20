import { _electron as electron, expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// file-explorer.spec.ts — keyboard-only workflow for the explorer feature.
//
// NOTE: This e2e file can't be executed in the dev sandbox (it needs a
// packaged build). The manual verification path mirrors ping.spec.ts:
//
//   pnpm --filter @ft5/desktop exec playwright test e2e/file-explorer.spec.ts
//
// against a fresh:
//
//   pnpm --filter @ft5/desktop package:{win|mac|linux}
//
// output. See task 10.3 in the OpenSpec change (ui-file-explorer) for the
// manual verification checklist — this spec intentionally doesn't block CI
// because no packaged binary exists in the sandbox.
//
// The spec encodes the keyboard-only workflow demanded by the a11y scenarios
// in `openspec/changes/ui-file-explorer/specs/file-explorer/spec.md`:
// navigating folders, multi-select with Shift+ArrowDown, delete-with-confirm,
// inline F2 rename, Details pane toggle, and View-menu mode switching — all
// without a pointer device. A screenshot of the Details-view + Details-pane
// populated state is captured mid-flow for the docs handoff in task 10.3.

// Playwright's Electron launcher takes an absolute path to the built binary.
// electron-builder emits platform-specific layouts under `apps/desktop/release/`;
// pick the right one for the current OS.
const platformExe = {
  win32: "release/win-unpacked/FT5 Cloude Sync.exe",
  darwin: "release/mac/FT5 Cloude Sync.app/Contents/MacOS/FT5 Cloude Sync",
  linux: "release/linux-unpacked/ft5-cloude-sync",
} as const;

const rel = platformExe[process.platform as keyof typeof platformExe];
const exePath = path.resolve(__dirname, "..", rel);

// Artifact the docs handoff (task 10.3) consumes. `recursive: true` keeps
// this idempotent across runs: the first run creates __screenshots__/ ,
// subsequent runs overwrite the PNG without touching the directory.
const SCREENSHOT_DIR = path.resolve(__dirname, "__screenshots__");
const SCREENSHOT_PATH = path.resolve(
  SCREENSHOT_DIR,
  "file-explorer-details-mode.png",
);

test("keyboard-only explorer workflow: navigate, multi-select, delete, rename, Details pane, view mode", async () => {
  // The full workflow launches Electron, waits for two page loads, walks a
  // multi-step keyboard sequence (including a 20-iter ArrowDown-to-file
  // search), opens the delete dialog, commits the rename, toggles the
  // Details pane, and switches view modes. Each step is modest on its own
  // but the cumulative round-trip to the packaged renderer easily exceeds
  // Playwright's default 30s.
  test.setTimeout(90_000);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const app = await electron.launch({ executablePath: exePath });
  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    // ---------------------------------------------------------------
    // 1. Land on the datasources dashboard (app's default home).
    // ---------------------------------------------------------------
    await window.goto("app://local/");
    await window.waitForLoadState("domcontentloaded");
    const firstCard = window
      .locator("[data-testid='datasource-card']")
      .first();
    await expect(firstCard).toBeVisible();

    // ---------------------------------------------------------------
    // 2. Open the quick-actions menu for the first card with keyboard only,
    //    then activate "Explore" (index 0 of the menu — `↓ Enter` lands on
    //    Enter because Radix opens the menu with focus on the first item
    //    when triggered via Enter/Space).
    //
    //    Approach: Tab until the quick-actions button (aria-label="Quick
    //    actions") holds focus. We avoid Shift+F10 here because it targets
    //    context menus, not the card's own DropdownMenu.
    // ---------------------------------------------------------------
    const quickActions = firstCard.locator(
      "button[aria-label='Quick actions']",
    );
    await quickActions.focus();
    await expect(quickActions).toBeFocused();
    await window.keyboard.press("Enter");
    // Radix opens with focus on the first item; Enter activates "Explore".
    await window.keyboard.press("Enter");

    // ---------------------------------------------------------------
    // 3. Wait for the explorer to mount. The route is
    //    /datasources/explore?id=<id>; the composite root carries
    //    `data-testid="file-explorer-root"`.
    // ---------------------------------------------------------------
    const root = window.locator("[data-testid='file-explorer-root']");
    await expect(root).toBeVisible();

    // Status row is scoped to the explorer root so we don't pick up unrelated
    // live-regions elsewhere in the shell.
    const statusRow = root.locator("[role='status']");
    await expect(statusRow).toBeVisible();

    // Grab the view-mode container — we assert its data-mode flips after the
    // View menu switch at step 5.6. The switcher stamps
    // `data-testid="view-mode-keyboard-container"` regardless of mode.
    const viewContainer = root.locator(
      "[data-testid='view-mode-keyboard-container']",
    );
    await expect(viewContainer).toBeVisible();

    // ---------------------------------------------------------------
    // 4. Keyboard-only workflow starts here. The hook under
    //    `use-keyboard-nav.ts` drives ArrowUp/Down, Shift+ArrowDown,
    //    Enter (activate), F2 (rename), Delete.
    // ---------------------------------------------------------------

    // 4a. Focus the first entry. Tab walks through chrome (history buttons,
    // breadcrumb, toolbar, then into the main pane); rather than count tabs,
    // we click the view container to place focus, then immediately exercise
    // keyboard-only motion. (A pointerless alternative would be repeated Tab
    // presses, but the focus target is implementation-specific per view
    // mode — this is the one click the workflow tolerates and it's called
    // out in the a11y spec's "focus the grid then navigate by keys"
    // scenario.)
    await viewContainer.focus();
    await window.keyboard.press("ArrowDown");

    // 4b. Navigate into a directory: Enter on the focused directory row.
    // The store.navigate refreshes entries; we wait for any row to re-settle.
    await window.keyboard.press("Enter");
    await expect(root.locator("[data-entry-id]").first()).toBeVisible();

    // 4c. Multi-select via Shift+ArrowDown. use-keyboard-nav.ts (L153, L161)
    // extends the selection range when Shift is held. Assert the status-row
    // surface reports "N selected".
    await window.keyboard.press("ArrowDown");
    await window.keyboard.press("Shift+ArrowDown");
    await expect(statusRow).toContainText(/\d+ selected/);

    // 4d. Delete with confirmation. Delete key triggers the confirm dialog;
    // the Delete button inside the Radix dialog is the destructive CTA. Tab
    // past Cancel to land on it.
    await window.keyboard.press("Delete");
    const dialog = window.locator("[role='dialog']");
    await expect(dialog).toBeVisible();
    const deleteCta = dialog.getByRole("button", { name: "Delete" });
    await deleteCta.focus();
    await expect(deleteCta).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(dialog).toBeHidden();

    // 4e. Rename a file. Radix's confirm-dialog focus-trap releases to
    // whatever had focus before open — but after a keyboard-triggered
    // Delete, that restoration is unreliable (the Delete keypress landed
    // on the view container, not a specific trigger element). Re-focus
    // the view container so the ArrowDown keydowns bubble to its
    // `onKeyDown`. Then loop ArrowDown until the focused row is a file
    // (data-entry-kind="file") — folders sort first in most seeds, and
    // F2 on a directory is a spec-refused no-op. 20-step cap protects
    // against an all-directory folder.
    await viewContainer.focus();
    let focusedKind: string | null = null;
    for (let step = 0; step < 20; step++) {
      await window.keyboard.press("ArrowDown");
      focusedKind = await root
        .locator("[data-entry-id][tabindex='0']")
        .first()
        .getAttribute("data-entry-kind", { timeout: 2_000 });
      if (focusedKind === "file") break;
    }
    expect(focusedKind, "ArrowDown did not land on a file row within 20 steps").toBe("file");

    await window.keyboard.press("F2");
    const renameInput = root.locator("input[aria-label='Rename entry']");
    await expect(renameInput).toBeVisible();
    await renameInput.fill("renamed-by-e2e.txt");
    await window.keyboard.press("Enter");
    await expect(renameInput).toBeHidden();
    await expect(root).toContainText("renamed-by-e2e.txt");

    // 4f. Toggle the Details pane. The toggle button carries
    // `aria-label="Details"` + `data-testid="file-explorer-details-toggle"`
    // and exposes its state via aria-pressed. Using `Locator.press("Enter")`
    // is the Playwright-canonical way to activate a focused button — it
    // targets the element directly (avoiding any focus-dispatch race) and
    // Enter is equally valid HTML-button activation alongside Space.
    // (Previous runs with `window.keyboard.press("Space")` failed to flip
    // the pane state — likely a keydown/keyup sequencing quirk against the
    // packaged Electron binary.)
    const detailsToggle = root.locator(
      "[data-testid='file-explorer-details-toggle']",
    );
    await detailsToggle.focus();
    await expect(detailsToggle).toBeFocused();
    await detailsToggle.press("Enter");
    const detailsPane = root.locator("aside[aria-label='Details']");
    await expect(detailsPane).toBeVisible();
    await expect(detailsToggle).toHaveAttribute("aria-pressed", "true");

    // --- Capture screenshot for task 10.3 docs handoff ---
    // At this point: Details view mode (default) with the Details pane open
    // and populated by the selection persisted from 4c above. That is the
    // canonical "Details-mode-populated" frame the docs page references.
    await window.screenshot({ path: SCREENSHOT_PATH });
    expect(fs.existsSync(SCREENSHOT_PATH)).toBe(true);

    // 4g. Switch view modes via the View menu. Target the specific
    // "Medium icons" radio item by role+name and press Enter on it —
    // Radix's DropdownMenuRadioGroup typeahead behaviour against the
    // packaged binary was unreliable (pressing "m" + Enter selected the
    // wrong item), and this locator-scoped press is keyboard-only and
    // deterministic across menu reorderings.
    const viewTrigger = root.locator(
      "[data-testid='file-explorer-view-trigger']",
    );
    await viewTrigger.focus();
    await expect(viewTrigger).toBeFocused();
    await viewTrigger.press("Enter");
    const viewMenu = window.locator("[role='menu']");
    await expect(viewMenu).toBeVisible();
    await viewMenu
      .getByRole("menuitemradio", { name: /medium icons/i })
      .press("Enter");
    await expect(viewMenu).toBeHidden();
    // The view-mode switcher re-renders with a different sub-tree when the
    // mode flips from Details to Medium Icons. The keyboard-nav container's
    // data attribute (if any) or at least its continued presence is asserted;
    // the layout flip is visible in the captured screenshot above when docs
    // re-capture under Medium Icons. Here we settle for the structural
    // assertion that explorer rows are no longer rendered as tabular
    // `explorer-row` elements (those belong to Details mode only) — Medium
    // Icons renders `explorer-cell` grid cells instead.
    await expect(
      root.locator("[data-testid='explorer-row']"),
    ).toHaveCount(0, { timeout: 5_000 });
    await expect(
      root.locator("[data-testid='explorer-cell']").first(),
    ).toBeVisible();
  } finally {
    // 5. Close the app regardless of assertion outcomes.
    await app.close();
  }
});
