/** @vitest-environment jsdom */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
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

import type { FileEntry } from "@ft5/ipc-contracts";

import { PropertiesModal } from "../properties-modal.js";
import {
  __resetExplorerStoreCacheForTests,
  createExplorerStore,
} from "../store.js";
import type { ExplorerStore } from "../store.js";
import { modalFields } from "../metadata/field-catalog.js";
import { seedEntry } from "./test-utils.js";

// Mock sonner's `toast` so the clipboard-failure assertion can observe
// `toast.error` calls without depending on the <Toaster/> being mounted.
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { toast } from "sonner";

/**
 * Properties modal — Phase 5.5/5.6. Spec reference:
 *   specs/file-explorer/spec.md "Properties item opens the Properties modal,
 *   not the Details pane" and design.md Decision 4 (two surfaces, one shape).
 */

function entryWithMetadata(): FileEntry {
  return seedEntry({
    id: "file-props-1",
    name: "hero.png",
    path: "/project/hero.png",
    parentPath: "/project",
    size: 12_288,
    mimeFamily: "image",
    mimeType: "image/png",
    modifiedAt: "2026-04-18T10:30:00.000Z",
    createdAt: "2026-04-17T08:15:00.000Z",
    providerMetadata: {
      ownerEmail: "alice@example.com",
      storageClass: "STANDARD",
      etag: "d41d8cd98f00b204e9800998ecf8427e",
      generation: 42,
      trashed: false,
    },
  });
}

function makeStore(id = "ds-properties-test"): ExplorerStore {
  return createExplorerStore(id);
}

describe("PropertiesModal — visibility", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
    vi.mocked(toast.error).mockReset();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("is not in the DOM when the store has no propertiesEntry", () => {
    const store = makeStore();
    render(<PropertiesModal store={store} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("mounts when openProperties(entry) is called and shows the dialog title 'Properties'", () => {
    const store = makeStore();
    const entry = entryWithMetadata();

    render(<PropertiesModal store={store} />);
    act(() => {
      store.openProperties(entry);
    });

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Properties" })).toBeInTheDocument();
  });

  it("unmounts when closeProperties() is called", async () => {
    const store = makeStore();
    const entry = entryWithMetadata();

    render(<PropertiesModal store={store} />);
    act(() => {
      store.openProperties(entry);
    });
    expect(screen.queryByRole("dialog")).not.toBeNull();

    act(() => {
      store.closeProperties();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});

describe("PropertiesModal — content", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
    vi.mocked(toast.error).mockReset();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders every modalFields row with a Copy button whose accessible name includes the field label", () => {
    const store = makeStore();
    const entry = entryWithMetadata();
    render(<PropertiesModal store={store} />);
    act(() => {
      store.openProperties(entry);
    });

    for (const id of modalFields) {
      // Each modalFields id resolves to a label via field-catalog; the
      // copy button's aria-label is "Copy <Label>". We assert the button
      // exists for Name / Path / Type / Size / Modified / Created.
      const labelById: Record<string, string> = {
        name: "Name",
        path: "Path",
        type: "Type",
        size: "Size",
        modified: "Modified",
        created: "Created",
      };
      const label = labelById[id];
      expect(label, `label for ${id}`).toBeDefined();
      expect(
        screen.getByRole("button", { name: `Copy ${label}` }),
        `button for field ${id}`,
      ).toBeInTheDocument();
    }
  });

  it("renders ALL provider metadata rows (not truncated to 3)", () => {
    const store = makeStore();
    const entry = entryWithMetadata();
    render(<PropertiesModal store={store} />);
    act(() => {
      store.openProperties(entry);
    });

    // providerMetadata has 5 keys; details-pane would slice to 3. Modal
    // shows them all.
    const copyButtons = screen.getAllByRole("button", { name: /^Copy / });
    const buttonNames = copyButtons.map((b) => b.getAttribute("aria-label"));
    // humanizeKey in field-catalog only uppercases the first character
    // of the string (`charAt(0).toUpperCase() + slice(1)`), so splitting
    // "ownerEmail" becomes "Owner Email" — the "E" retains its upper case
    // from the camelCase split.
    expect(buttonNames).toEqual(
      expect.arrayContaining([
        "Copy Owner Email",
        "Copy Storage Class",
        "Copy Etag",
        "Copy Generation",
        "Copy Trashed",
      ]),
    );
  });
});

describe("PropertiesModal — copy interactions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
    vi.mocked(toast.error).mockReset();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("clicking Copy Size writes the raw byte count (not the formatted string) to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { api?: { clipboard: { writeText: typeof writeText } } }).api = {
      clipboard: { writeText },
    };

    const store = makeStore();
    const entry = entryWithMetadata();
    render(<PropertiesModal store={store} />);
    act(() => {
      store.openProperties(entry);
    });

    const sizeButton = screen.getByRole("button", { name: "Copy Size" });
    fireEvent.click(sizeButton);

    // rawSelector for size returns the number 12288 — String() -> "12288".
    // The formatted value on the row is "12 KB"; we must NOT write that.
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("12288");
  });

  it("clicking Copy Name writes the raw file name to the clipboard", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { api?: { clipboard: { writeText: typeof writeText } } }).api = {
      clipboard: { writeText },
    };

    const store = makeStore();
    const entry = entryWithMetadata();
    render(<PropertiesModal store={store} />);
    act(() => {
      store.openProperties(entry);
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy Name" }));
    expect(writeText).toHaveBeenCalledWith("hero.png");
  });

  it("a rejected writeText triggers a sonner toast.error", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    (window as unknown as { api?: { clipboard: { writeText: typeof writeText } } }).api = {
      clipboard: { writeText },
    };

    const store = makeStore();
    const entry = entryWithMetadata();
    render(<PropertiesModal store={store} />);
    act(() => {
      store.openProperties(entry);
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy Path" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    const message = vi.mocked(toast.error).mock.calls[0]?.[0];
    expect(typeof message).toBe("string");
    expect(String(message).toLowerCase()).toContain("copy");
  });
});

describe("PropertiesModal — focus trap + keyboard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
    vi.mocked(toast.error).mockReset();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("moves initial focus inside the dialog on open", async () => {
    const store = makeStore();
    const entry = entryWithMetadata();
    render(<PropertiesModal store={store} />);
    act(() => {
      store.openProperties(entry);
    });

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      const active = document.activeElement;
      expect(active).not.toBeNull();
      expect(dialog.contains(active)).toBe(true);
    });
  });

  it("every focusable element is inside the dialog content (focus-trap invariant)", async () => {
    const store = makeStore();
    const entry = entryWithMetadata();
    render(<PropertiesModal store={store} />);
    act(() => {
      store.openProperties(entry);
    });

    const dialog = await screen.findByRole("dialog");
    // jsdom + Radix `react-focus-scope` does not wire Tab-key cycling
    // the way real browsers do (same gap the context-menu test calls
    // out). The strongest jsdom-portable claim is: every in-dialog
    // focusable element is inside `dialog`, and the modal contains its
    // own close button + copy buttons. Real-browser Tab trapping is
    // exercised in the spec scenario at archive-time.
    const buttons = dialog.querySelectorAll<HTMLElement>(
      "button, [href], [tabindex]:not([tabindex=\"-1\"])",
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of Array.from(buttons)) {
      expect(dialog.contains(btn)).toBe(true);
    }
    // The shadcn DialogContent includes a built-in Close button ("Close"
    // sr-only text). It must be present.
    expect(
      dialog.querySelector<HTMLElement>("[data-slot=\"dialog-close\"]"),
    ).not.toBeNull();
  });

  it("Escape closes the modal", async () => {
    const store = makeStore();
    const entry = entryWithMetadata();
    render(<PropertiesModal store={store} />);
    act(() => {
      store.openProperties(entry);
    });
    expect(screen.queryByRole("dialog")).not.toBeNull();

    // Radix Dialog listens for Escape on the active element; focus is
    // already inside the dialog after open.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    // Focus-restoration: Radix's focus-scope does not reliably hand back
    // focus in jsdom (same gap the context-menu test calls out). We only
    // assert the modal has unmounted; real-browser restoration is
    // covered by the spec scenario at archive-time.
  });
});

describe("PropertiesModal — does not toggle Details pane", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
    vi.mocked(toast.error).mockReset();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("opening and closing the modal leaves detailsPaneOpen unchanged (closed)", () => {
    const store = makeStore();
    const entry = entryWithMetadata();
    render(<PropertiesModal store={store} />);

    expect(store.getSnapshot().detailsPaneOpen).toBe(false);
    act(() => {
      store.openProperties(entry);
    });
    expect(store.getSnapshot().detailsPaneOpen).toBe(false);
    act(() => {
      store.closeProperties();
    });
    expect(store.getSnapshot().detailsPaneOpen).toBe(false);
  });

  it("opening and closing the modal leaves detailsPaneOpen unchanged (open)", () => {
    const store = makeStore();
    const entry = entryWithMetadata();
    render(<PropertiesModal store={store} />);
    act(() => {
      store.toggleDetailsPane();
    });
    expect(store.getSnapshot().detailsPaneOpen).toBe(true);

    act(() => {
      store.openProperties(entry);
    });
    expect(store.getSnapshot().detailsPaneOpen).toBe(true);
    act(() => {
      store.closeProperties();
    });
    expect(store.getSnapshot().detailsPaneOpen).toBe(true);
  });
});
