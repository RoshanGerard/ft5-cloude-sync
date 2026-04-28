/** @vitest-environment jsdom */
//
// add-engine-rename-download §21.1 — RED tests for `<FirstDownloadModal />`.
//
// The first-run downloads modal blocks on the user's first-ever
// download (detected by the absence of `ft5.downloads.defaultFolder` in
// localStorage). It collects the default downloads folder, persists
// the choice, and only then dispatches the deferred download. The
// blocking nature is non-negotiable per spec.md § "Modal cannot be
// dismissed without commit" — Escape, backdrop click, and the X close
// button are all suppressed; only the primary "Use this folder" CTA
// closes it.
//
// Mock surface mirrors `upload-dialog.test.tsx`:
//   - window.api.dialog.showOpenDialog stubbed (the Browse button's
//     surface introduced in this section's prerequisite extension).
//   - window.api.preferences.setDefaultDownloadsFolder stubbed (the
//     mirror call from `setDefaultFolder` per §20).

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
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { useState } from "react";

import { FirstDownloadModal } from "../first-download-modal.js";
import {
  DOWNLOADS_DEFAULT_FOLDER_KEY,
  getDefaultFolder,
} from "../../settings/downloads-store.js";

// Radix Dialog needs ResizeObserver at mount, mirroring the polyfill in
// settings-dialog.test / add-dialog.test.
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
});

let showOpenDialogMock: Mock;
let setDefaultDownloadsFolderMock: Mock;

function installApiMock(): void {
  showOpenDialogMock = vi.fn(async () => ({
    canceled: false,
    filePaths: [] as readonly string[],
  }));
  setDefaultDownloadsFolderMock = vi.fn(async () => {});
  (window as unknown as { api: unknown }).api = {
    dialog: {
      showOpenDialog: showOpenDialogMock,
    },
    preferences: {
      setDefaultDownloadsFolder: setDefaultDownloadsFolderMock,
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  delete (window as unknown as { api?: unknown }).api;
});

describe("FirstDownloadModal — first-run defaults collection", () => {
  it("renders the spec'd title and body copy", () => {
    installApiMock();
    render(<FirstDownloadModal open={true} onCommit={() => {}} />);

    expect(
      screen.getByRole("heading", { name: /where should downloads go\?/i }),
    ).toBeInTheDocument();
    // Body copy from design.md V3 — match loosely on the key phrase
    // ("change this later in Settings") so future copy-tweaks don't
    // brittle the assertion.
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/change this later in Settings/i);
    expect(body).toMatch(/Save as/i);
  });

  it("pre-fills the path input with the OS-default-style fallback", () => {
    installApiMock();
    render(<FirstDownloadModal open={true} onCommit={() => {}} />);

    const input = screen.getByLabelText(
      /downloads folder/i,
    ) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    // The renderer falls back to a sensible string — `~/Downloads/ft5`
    // — when no preload-exposed OS-default is available.
    expect(input.value).toBe("~/Downloads/ft5");
  });

  it("renders Browse button and a single 'Use this folder' CTA", () => {
    installApiMock();
    render(<FirstDownloadModal open={true} onCommit={() => {}} />);

    expect(
      screen.getByRole("button", { name: /browse/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /use this folder/i }),
    ).toBeInTheDocument();
  });

  it("does NOT render an X close button (no Skip / Close affordance)", () => {
    installApiMock();
    render(<FirstDownloadModal open={true} onCommit={() => {}} />);

    // The shadcn Dialog renders an X close affordance by default. Per
    // the spec (§ "Modal cannot be dismissed without commit"), it must
    // be hidden — `showCloseButton={false}` on DialogContent.
    expect(
      screen.queryByRole("button", { name: /^close$/i }),
    ).not.toBeInTheDocument();
  });

  it("suppresses Escape-key dismissal", () => {
    installApiMock();
    const onCommit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <FirstDownloadModal
        open={true}
        onCommit={onCommit}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    // Modal must not close — neither the commit path nor the
    // open-change path should fire with `false`.
    expect(onCommit).not.toHaveBeenCalled();
    expect(
      onOpenChange.mock.calls.some(([open]) => open === false),
    ).toBe(false);
    // CTA still mounted.
    expect(
      screen.getByRole("button", { name: /use this folder/i }),
    ).toBeInTheDocument();
  });

  it("suppresses pointer-down-outside (backdrop click) dismissal", () => {
    installApiMock();
    const onCommit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <FirstDownloadModal
        open={true}
        onCommit={onCommit}
        onOpenChange={onOpenChange}
      />,
    );

    // The Radix Dialog overlay receives backdrop pointer events.
    // Locate the backdrop via its data-slot attribute.
    const overlay = document.querySelector(
      '[data-slot="dialog-overlay"]',
    );
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay as Element);
    fireEvent.mouseDown(overlay as Element);

    expect(onCommit).not.toHaveBeenCalled();
    expect(
      onOpenChange.mock.calls.some(([open]) => open === false),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: /use this folder/i }),
    ).toBeInTheDocument();
  });

  it("on Browse click, invokes window.api.dialog.showOpenDialog with the directory-pick properties", async () => {
    installApiMock();
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/Users/alice/cloud-files"],
    });
    render(<FirstDownloadModal open={true} onCommit={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    await Promise.resolve();
    await Promise.resolve();

    expect(showOpenDialogMock).toHaveBeenCalledTimes(1);
    const opts = showOpenDialogMock.mock.calls[0][0] as {
      properties: readonly string[];
    };
    expect(opts.properties).toContain("openDirectory");
    expect(opts.properties).toContain("createDirectory");
  });

  it("on Browse selection, updates the path input to the chosen folder", async () => {
    installApiMock();
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/Users/alice/cloud-files"],
    });
    render(<FirstDownloadModal open={true} onCommit={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /browse/i }));

    await waitFor(() => {
      const input = screen.getByLabelText(
        /downloads folder/i,
      ) as HTMLInputElement;
      expect(input.value).toBe("/Users/alice/cloud-files");
    });
  });

  it("on Browse cancel, leaves the path input untouched", async () => {
    installApiMock();
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    render(<FirstDownloadModal open={true} onCommit={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    await Promise.resolve();
    await Promise.resolve();

    const input = screen.getByLabelText(
      /downloads folder/i,
    ) as HTMLInputElement;
    expect(input.value).toBe("~/Downloads/ft5");
  });

  it("on commit, persists via setDefaultFolder and invokes onCommit with the chosen path", () => {
    installApiMock();
    const onCommit = vi.fn();
    render(<FirstDownloadModal open={true} onCommit={onCommit} />);

    fireEvent.click(
      screen.getByRole("button", { name: /use this folder/i }),
    );

    expect(localStorage.getItem(DOWNLOADS_DEFAULT_FOLDER_KEY)).toBe(
      "~/Downloads/ft5",
    );
    expect(getDefaultFolder()).toBe("~/Downloads/ft5");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("~/Downloads/ft5");
  });
});

// §21.3 — integration test for the modal-trigger flow. Per the task,
// the orchestrator-side wiring lands in §23; this test exercises the
// contract via a thin harness that mimics the orchestrator's "queue
// download until folder is set" flow. The harness:
//   1. captures the dispatch on the first Download click,
//   2. opens the modal because getDefaultFolder() is null,
//   3. flushes the queued dispatch on modal commit.
describe("FirstDownloadModal — integration with deferred download trigger", () => {
  function TriggerHarness({
    onDispatch,
  }: {
    onDispatch: (folder: string) => void;
  }) {
    const [open, setOpen] = useState(false);
    const [pendingFile, setPending] = useState<string | null>(null);

    const handleDownload = (fileName: string) => {
      const folder = getDefaultFolder();
      if (folder === null) {
        setPending(fileName);
        setOpen(true);
        return;
      }
      onDispatch(folder);
    };

    const handleCommit = (folder: string) => {
      setOpen(false);
      if (pendingFile !== null) {
        onDispatch(folder);
        setPending(null);
      }
    };

    return (
      <>
        <button
          type="button"
          onClick={() => handleDownload("welcome.pdf")}
        >
          Trigger download
        </button>
        <FirstDownloadModal open={open} onCommit={handleCommit} />
      </>
    );
  }

  it("opens the modal on the first download click when getDefaultFolder() is null", () => {
    installApiMock();
    const onDispatch = vi.fn();
    render(<TriggerHarness onDispatch={onDispatch} />);

    expect(
      screen.queryByRole("heading", {
        name: /where should downloads go\?/i,
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /trigger download/i }),
    );

    expect(
      screen.getByRole("heading", {
        name: /where should downloads go\?/i,
      }),
    ).toBeInTheDocument();
    // Download is queued — no dispatch yet.
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it("on modal commit, dispatches the deferred download against the now-set folder", () => {
    installApiMock();
    const onDispatch = vi.fn();
    render(<TriggerHarness onDispatch={onDispatch} />);

    fireEvent.click(
      screen.getByRole("button", { name: /trigger download/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /use this folder/i }),
    );

    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch).toHaveBeenCalledWith("~/Downloads/ft5");
    expect(getDefaultFolder()).toBe("~/Downloads/ft5");
  });
});
