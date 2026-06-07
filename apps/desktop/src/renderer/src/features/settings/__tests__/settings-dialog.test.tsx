/** @vitest-environment jsdom */
//
// SettingsDialog — the Settings modal triggered by the header's Settings
// button. First and only section (this phase): Motion. Hosts a Switch that
// drives the motion-store preference. Default (always-on) = switch OFF;
// toggling on writes `safe` to localStorage and sets `data-motion="safe"` on
// <html>, which activates the CSS override in globals.css.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { SettingsDialog } from "../settings-dialog";
import { MOTION_STORAGE_KEY } from "../motion-store";
import {
  DOWNLOADS_ALWAYS_ASK_KEY,
  DOWNLOADS_DEFAULT_FOLDER_KEY,
} from "../downloads-store";
import { EXPLORER_PAGE_SIZE_KEY } from "../../file-explorer/store";

// Radix DropdownMenu / Dialog rely on ResizeObserver at mount. Mirror the
// polyfill used in card.test / add-dialog.test.
beforeEach(() => {
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
  localStorage.clear();
  document.documentElement.removeAttribute("data-motion");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("data-motion");
});

describe("SettingsDialog — Motion Safe section", () => {
  it("renders a dialog with the 'Settings' title when open", () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    expect(
      screen.getByRole("heading", { name: /settings/i }),
    ).toBeInTheDocument();
  });

  it("renders a Motion Safe switch whose default state reflects the store (unchecked / always-on)", () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    const toggle = screen.getByRole("switch", { name: /motion safe/i });
    expect(toggle).toBeInTheDocument();
    // Default preference is `always-on` → switch reads as unchecked.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects an existing 'safe' preference on mount (switch reads as checked)", () => {
    localStorage.setItem(MOTION_STORAGE_KEY, "safe");
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    const toggle = screen.getByRole("switch", { name: /motion safe/i });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("toggling the switch ON writes 'safe' to storage and sets data-motion='safe'", () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    const toggle = screen.getByRole("switch", { name: /motion safe/i });
    fireEvent.click(toggle);

    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("safe");
    expect(document.documentElement.getAttribute("data-motion")).toBe("safe");
  });

  it("toggling the switch OFF (from safe) removes the storage key and the attribute", () => {
    localStorage.setItem(MOTION_STORAGE_KEY, "safe");
    document.documentElement.setAttribute("data-motion", "safe");
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    const toggle = screen.getByRole("switch", { name: /motion safe/i });
    fireEvent.click(toggle);

    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
  });

  it("restores focus to the trigger on close via returnFocusTo", async () => {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.textContent = "Open Settings";
    document.body.appendChild(trigger);

    const onOpenChange = vi.fn();
    const { rerender } = render(
      <SettingsDialog
        open={true}
        onOpenChange={onOpenChange}
        returnFocusTo={trigger}
      />,
    );

    // Dialog close via prop. Radix invokes onCloseAutoFocus on the content,
    // which the SettingsDialog implementation uses to redirect focus to the
    // returnFocusTo element (same pattern as AddDatasourceDialog — focus
    // restoration is async under Radix, so we poll with waitFor).
    rerender(
      <SettingsDialog
        open={false}
        onOpenChange={onOpenChange}
        returnFocusTo={trigger}
      />,
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });

    trigger.remove();
  });

  it("provides the help sentence describing the toggle behaviour", () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    // The copy should reference the OS reduce-motion behaviour so users know
    // what the toggle actually does. We match loosely on keywords rather than
    // pinning the exact wording.
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/reduce[ -]motion|system/i);
  });
});

// add-engine-rename-download §22 — Downloads section RED tests.
//
// The new section sits as a sibling of Motion. Two rows:
//   - Default folder: path display + Open + Change… buttons.
//   - "Always ask where to save" Switch.
// Mock surface mirrors `first-download-modal.test.tsx`:
//   window.api.dialog.showOpenDialog (Change… button) and
//   window.api.files.showSavedInFolder (Open button), plus a stub for
//   the §20 store's main-process mirror call.
let showOpenDialogMock: Mock;
let showSavedInFolderMock: Mock;
let setDefaultDownloadsFolderMock: Mock;

function installDownloadsApiMock(): void {
  showOpenDialogMock = vi.fn(async () => ({
    canceled: false,
    filePaths: [] as readonly string[],
  }));
  showSavedInFolderMock = vi.fn(async () => {});
  setDefaultDownloadsFolderMock = vi.fn(async () => {});
  (window as unknown as { api: unknown }).api = {
    dialog: {
      showOpenDialog: showOpenDialogMock,
    },
    files: {
      showSavedInFolder: showSavedInFolderMock,
    },
    preferences: {
      setDefaultDownloadsFolder: setDefaultDownloadsFolderMock,
    },
  };
}

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api;
});

describe("SettingsDialog — Downloads section", () => {
  it("renders a 'Downloads' heading as a sibling of the Motion section", () => {
    installDownloadsApiMock();
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    expect(
      screen.getByRole("heading", { name: /downloads/i }),
    ).toBeInTheDocument();
    // Motion heading still present — Downloads sits as a sibling, not
    // a replacement.
    expect(
      screen.getByRole("heading", { name: /motion/i }),
    ).toBeInTheDocument();
  });

  it("renders the stored default folder path with Open and Change buttons", () => {
    installDownloadsApiMock();
    localStorage.setItem(
      DOWNLOADS_DEFAULT_FOLDER_KEY,
      "/Users/alice/Downloads/ft5",
    );

    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    expect(
      screen.getByText("/Users/alice/Downloads/ft5"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^open$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /change/i }),
    ).toBeInTheDocument();
  });

  it("renders 'Not set' and disables Open when no default folder is stored", () => {
    installDownloadsApiMock();
    // No localStorage seeding — `useDefaultFolder()` returns null.

    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    expect(screen.getByText(/not set/i)).toBeInTheDocument();
    // Open is disabled when there's nothing to reveal; Change… stays
    // active so the user can pick a folder for the first time.
    expect(
      screen.getByRole("button", { name: /^open$/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /change/i }),
    ).not.toBeDisabled();
  });

  it("Open invokes window.api.files.showSavedInFolder with the stored folder", () => {
    installDownloadsApiMock();
    localStorage.setItem(
      DOWNLOADS_DEFAULT_FOLDER_KEY,
      "/Users/alice/Downloads/ft5",
    );
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));

    expect(showSavedInFolderMock).toHaveBeenCalledTimes(1);
    expect(showSavedInFolderMock).toHaveBeenCalledWith(
      "/Users/alice/Downloads/ft5",
    );
  });

  it("Change opens the OS picker with directory-pick properties and updates the store on confirm", async () => {
    installDownloadsApiMock();
    localStorage.setItem(
      DOWNLOADS_DEFAULT_FOLDER_KEY,
      "/Users/alice/Downloads/ft5",
    );
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/Users/alice/cloud-files"],
    });

    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /change/i }));

    await waitFor(() => {
      expect(showOpenDialogMock).toHaveBeenCalledTimes(1);
    });
    const opts = showOpenDialogMock.mock.calls[0][0] as {
      properties: readonly string[];
    };
    expect(opts.properties).toContain("openDirectory");
    expect(opts.properties).toContain("createDirectory");

    await waitFor(() => {
      expect(localStorage.getItem(DOWNLOADS_DEFAULT_FOLDER_KEY)).toBe(
        "/Users/alice/cloud-files",
      );
    });

    // Updated path should render immediately (the store hook re-renders
    // the dialog).
    await waitFor(() => {
      expect(
        screen.getByText("/Users/alice/cloud-files"),
      ).toBeInTheDocument();
    });
  });

  it("Change does NOT update the store on cancel", async () => {
    installDownloadsApiMock();
    localStorage.setItem(
      DOWNLOADS_DEFAULT_FOLDER_KEY,
      "/Users/alice/Downloads/ft5",
    );
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });

    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /change/i }));

    await waitFor(() => {
      expect(showOpenDialogMock).toHaveBeenCalledTimes(1);
    });
    // Stored value untouched.
    expect(localStorage.getItem(DOWNLOADS_DEFAULT_FOLDER_KEY)).toBe(
      "/Users/alice/Downloads/ft5",
    );
  });

  it("renders the 'Always ask where to save' Switch with the body copy", () => {
    installDownloadsApiMock();
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    const toggle = screen.getByRole("switch", {
      name: /always ask where to save/i,
    });
    expect(toggle).toBeInTheDocument();
    // Default = absent key → switch unchecked.
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Show the Save-as dialog for every download/i);
  });

  it("toggling the Always-ask Switch ON writes 'yes' to the localStorage key", () => {
    installDownloadsApiMock();
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    const toggle = screen.getByRole("switch", {
      name: /always ask where to save/i,
    });
    fireEvent.click(toggle);

    expect(localStorage.getItem(DOWNLOADS_ALWAYS_ASK_KEY)).toBe("yes");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("toggling the Always-ask Switch OFF (from yes) removes the localStorage key", () => {
    installDownloadsApiMock();
    localStorage.setItem(DOWNLOADS_ALWAYS_ASK_KEY, "yes");
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    const toggle = screen.getByRole("switch", {
      name: /always ask where to save/i,
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    expect(localStorage.getItem(DOWNLOADS_ALWAYS_ASK_KEY)).toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("focus-trap reaches the Downloads section: Tab from Motion's Switch lands on the Open button next", () => {
    installDownloadsApiMock();
    localStorage.setItem(
      DOWNLOADS_DEFAULT_FOLDER_KEY,
      "/Users/alice/Downloads/ft5",
    );
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    const motionSwitch = screen.getByRole("switch", {
      name: /motion safe/i,
    });
    const openButton = screen.getByRole("button", { name: /^open$/i });
    const changeButton = screen.getByRole("button", { name: /change/i });
    const alwaysAskSwitch = screen.getByRole("switch", {
      name: /always ask where to save/i,
    });

    // Tab order is determined by DOM order. Verify the four
    // focusable controls appear in the expected sequence:
    // Motion switch → Open → Change → Always-ask switch.
    const all = Array.from(
      document.querySelectorAll(
        'button, [role="switch"], input, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !(el as HTMLButtonElement).disabled);

    const motionIdx = all.indexOf(motionSwitch);
    const openIdx = all.indexOf(openButton);
    const changeIdx = all.indexOf(changeButton);
    const alwaysAskIdx = all.indexOf(alwaysAskSwitch);

    expect(motionIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeGreaterThan(motionIdx);
    expect(changeIdx).toBeGreaterThan(openIdx);
    expect(alwaysAskIdx).toBeGreaterThan(changeIdx);
  });
});

// add-engine-listdirectory-pagination §12 — Explorer section RED tests.
//
// Visual direction V-4 + spec "Settings dialog includes an Explorer section
// with a Page-size dropdown". The section sits BETWEEN Motion and Downloads.
// One row: "Items loaded per page" label + a DropdownMenu/RadioGroup of five
// page-size options (100 / 500 / 1,000 / 5,000 / 10,000). The selected value
// persists to the store's `EXPLORER_PAGE_SIZE_KEY` (un-formatted integer
// string) and defaults to 500 on first read.
//
// Radix DropdownMenu opens on `pointerDown` (not `click`) in jsdom and mounts
// its items in a portal — mirror the proven recipe from
// features/file-explorer/__tests__/toolbar.test.tsx (ViewMenu).
const PAGE_SIZE_TRIGGER_NAME = /items loaded per page/i;

function getPageSizeTrigger(): HTMLElement {
  return screen.getByRole("button", { name: PAGE_SIZE_TRIGGER_NAME });
}

function openPageSizeMenu(): void {
  // Radix DropdownMenu responds to pointerDown(button:0), not synthetic click.
  fireEvent.pointerDown(getPageSizeTrigger(), { button: 0 });
}

describe("SettingsDialog — Explorer section (page size)", () => {
  it("renders an 'Explorer' heading positioned between Motion and Downloads", () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    const motion = screen.getByRole("heading", { name: /motion/i });
    const explorer = screen.getByRole("heading", { name: /explorer/i });
    const downloads = screen.getByRole("heading", { name: /downloads/i });

    // Heading siblings appear in DOM order top-down: General → Browsing →
    // File-handling (Motion → Explorer → Downloads per V-4).
    const headings = Array.from(
      document.querySelectorAll("h3"),
    ) as HTMLHeadingElement[];
    const motionIdx = headings.indexOf(motion as HTMLHeadingElement);
    const explorerIdx = headings.indexOf(explorer as HTMLHeadingElement);
    const downloadsIdx = headings.indexOf(downloads as HTMLHeadingElement);

    expect(motionIdx).toBeGreaterThanOrEqual(0);
    expect(explorerIdx).toBeGreaterThan(motionIdx);
    expect(downloadsIdx).toBeGreaterThan(explorerIdx);
  });

  it("renders the 'Items loaded per page' label and the description copy", () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    expect(screen.getByText("Items loaded per page")).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).toMatch(
      /Larger values fetch more per click; smaller values paint faster on first load\./,
    );
  });

  it("default page size is 500 on first read — trigger shows '500'", () => {
    // No localStorage seeding → readExplorerPageSize() returns the default.
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    const trigger = getPageSizeTrigger();
    expect(trigger).toBeInTheDocument();
    expect((trigger.textContent ?? "").trim()).toBe("500");
  });

  it("reflects a persisted value on mount with comma formatting (1000 → '1,000')", () => {
    localStorage.setItem(EXPLORER_PAGE_SIZE_KEY, "1000");
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    expect((getPageSizeTrigger().textContent ?? "").trim()).toBe("1,000");
  });

  it("trigger is a native <button type='button'> carrying the aria-label", () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    const trigger = getPageSizeTrigger();
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("type", "button");
    expect(trigger).toHaveAttribute("aria-label", "Items loaded per page");
  });

  it("opening the menu shows five radio items with comma-formatted labels and a 'Page size' label", async () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    openPageSizeMenu();

    const items = await screen.findAllByRole("menuitemradio");
    expect(items).toHaveLength(5);
    const labels = items.map((el) => (el.textContent ?? "").trim());
    expect(labels).toEqual(["100", "500", "1,000", "5,000", "10,000"]);

    // The leading DropdownMenuLabel reads "Page size".
    expect(screen.getByText("Page size")).toBeInTheDocument();
  });

  it("marks the active value (default 500) as the checked radio item", async () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    openPageSizeMenu();

    const items = await screen.findAllByRole("menuitemradio");
    const checked = items.map((el) => el.getAttribute("aria-checked"));
    // Order: 100, 500, 1,000, 5,000, 10,000 → index 1 is "500".
    expect(checked).toEqual(["false", "true", "false", "false", "false"]);
  });

  it("selecting '1,000' persists the un-formatted integer string and updates the trigger", async () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    openPageSizeMenu();

    const item = (await screen.findAllByRole("menuitemradio")).find(
      (el) => (el.textContent ?? "").trim() === "1,000",
    );
    expect(item).toBeDefined();

    act(() => {
      fireEvent.click(item!);
    });

    // Persisted value carries NO comma (the raw integer string).
    expect(localStorage.getItem(EXPLORER_PAGE_SIZE_KEY)).toBe("1000");
    // Trigger reflects the new value (comma-formatted display).
    expect((getPageSizeTrigger().textContent ?? "").trim()).toBe("1,000");
    // Menu closed after selection.
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
  });

  it("every one of the five options is selectable and persists its raw value", async () => {
    const cases: ReadonlyArray<{ label: string; stored: string }> = [
      { label: "100", stored: "100" },
      { label: "500", stored: "500" },
      { label: "1,000", stored: "1000" },
      { label: "5,000", stored: "5000" },
      { label: "10,000", stored: "10000" },
    ];

    for (const { label, stored } of cases) {
      localStorage.clear();
      const { unmount } = render(
        <SettingsDialog open={true} onOpenChange={() => {}} />,
      );
      openPageSizeMenu();
      const item = (await screen.findAllByRole("menuitemradio")).find(
        (el) => (el.textContent ?? "").trim() === label,
      );
      expect(item, `option ${label} should render`).toBeDefined();
      act(() => {
        fireEvent.click(item!);
      });
      expect(
        localStorage.getItem(EXPLORER_PAGE_SIZE_KEY),
        `selecting ${label} persists ${stored}`,
      ).toBe(stored);
      unmount();
      cleanup();
    }
  });

  it("Tab order reaches the Page-size trigger between the Motion switch and the Downloads Open button", () => {
    installDownloadsApiMock();
    localStorage.setItem(
      DOWNLOADS_DEFAULT_FOLDER_KEY,
      "/Users/alice/Downloads/ft5",
    );
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    const motionSwitch = screen.getByRole("switch", { name: /motion safe/i });
    const pageSizeTrigger = getPageSizeTrigger();
    const openButton = screen.getByRole("button", { name: /^open$/i });

    const all = Array.from(
      document.querySelectorAll(
        'button, [role="switch"], input, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !(el as HTMLButtonElement).disabled);

    const motionIdx = all.indexOf(motionSwitch);
    const pageSizeIdx = all.indexOf(pageSizeTrigger);
    const openIdx = all.indexOf(openButton);

    expect(motionIdx).toBeGreaterThanOrEqual(0);
    expect(pageSizeIdx).toBeGreaterThan(motionIdx);
    expect(openIdx).toBeGreaterThan(pageSizeIdx);
  });
});
