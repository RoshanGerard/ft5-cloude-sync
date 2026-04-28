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
let getOSDefaultDownloadsFolderMock: Mock;

// Post-archive bug-fix follow-up — the modal pre-fills via
// `window.api.preferences.getOSDefaultDownloadsFolder()`. Tests stub the
// bridge with a fixed POSIX-style path; production uses `app.getPath
// ("downloads")` per the new IPC handler in `main/ipc/preferences.ts`.
const FIXTURE_OS_DOWNLOADS = "/Users/alice/Downloads";
const EXPECTED_PREFILL = "/Users/alice/Downloads/ft5";

function installApiMock(): void {
  showOpenDialogMock = vi.fn(async () => ({
    canceled: false,
    filePaths: [] as readonly string[],
  }));
  setDefaultDownloadsFolderMock = vi.fn(async () => {});
  getOSDefaultDownloadsFolderMock = vi.fn(async () => FIXTURE_OS_DOWNLOADS);
  (window as unknown as { api: unknown }).api = {
    dialog: {
      showOpenDialog: showOpenDialogMock,
    },
    preferences: {
      setDefaultDownloadsFolder: setDefaultDownloadsFolderMock,
      getOSDefaultDownloadsFolder: getOSDefaultDownloadsFolderMock,
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

  it("pre-fills the path input with the OS-resolved downloads folder + 'ft5'", async () => {
    installApiMock();
    render(<FirstDownloadModal open={true} onCommit={() => {}} />);

    const input = screen.getByLabelText(
      /downloads folder/i,
    ) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    // Post-archive bug fix: the modal resolves the real OS default via
    // `window.api.preferences.getOSDefaultDownloadsFolder` and appends
    // `ft5` with the host-correct separator (the `joinFolderAndName`
    // helper from `use-download-orchestrator`). The earlier hard-coded
    // `"~/Downloads/ft5"` is gone — that string is not absolute and
    // failed the service-side `path.isAbsolute` validator.
    await waitFor(() => {
      expect(getOSDefaultDownloadsFolderMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(input.value).toBe(EXPECTED_PREFILL);
    });
  });

  it("pre-fills with a Windows-style path when the OS default contains backslashes", async () => {
    installApiMock();
    // Use a real Windows-shaped fixture (drive + backslashes) so the
    // host-aware joiner picks `\` as the separator. The TS string
    // literal uses doubled backslashes so the runtime value is
    // `C:\Users\dev2\Downloads`.
    getOSDefaultDownloadsFolderMock.mockResolvedValueOnce(
      "C:\\Users\\dev2\\Downloads",
    );
    render(<FirstDownloadModal open={true} onCommit={() => {}} />);

    const input = screen.getByLabelText(
      /downloads folder/i,
    ) as HTMLInputElement;
    await waitFor(() => {
      expect(input.value).toBe("C:\\Users\\dev2\\Downloads\\ft5");
    });
  });

  it("starts with an empty input and disables the CTA until the OS default resolves", async () => {
    installApiMock();
    // Stall the resolution so we can observe the initial empty + disabled state.
    let resolveOSDefault!: (v: string) => void;
    getOSDefaultDownloadsFolderMock.mockImplementationOnce(
      () =>
        new Promise<string>((res) => {
          resolveOSDefault = res;
        }),
    );
    render(<FirstDownloadModal open={true} onCommit={() => {}} />);

    const input = screen.getByLabelText(
      /downloads folder/i,
    ) as HTMLInputElement;
    expect(input.value).toBe("");
    const cta = screen.getByRole("button", { name: /use this folder/i });
    expect(cta).toBeDisabled();

    resolveOSDefault(FIXTURE_OS_DOWNLOADS);
    await waitFor(() => expect(input.value).toBe(EXPECTED_PREFILL));
    expect(cta).not.toBeDisabled();
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

  it("on Browse cancel, leaves the path input at the OS-resolved pre-fill", async () => {
    installApiMock();
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    render(<FirstDownloadModal open={true} onCommit={() => {}} />);

    // Wait for the OS-default-folder pre-fill before clicking Browse.
    const input = screen.getByLabelText(
      /downloads folder/i,
    ) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(EXPECTED_PREFILL));

    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    await Promise.resolve();
    await Promise.resolve();

    expect(input.value).toBe(EXPECTED_PREFILL);
  });

  it("on commit, persists via setDefaultFolder and invokes onCommit with the OS-resolved path", async () => {
    installApiMock();
    const onCommit = vi.fn();
    render(<FirstDownloadModal open={true} onCommit={onCommit} />);

    // Wait for the OS-default-folder pre-fill to land in the input
    // before clicking the CTA — the CTA is disabled until the bridge
    // resolves, so a synchronous click would be a no-op.
    const input = screen.getByLabelText(
      /downloads folder/i,
    ) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe(EXPECTED_PREFILL));

    fireEvent.click(
      screen.getByRole("button", { name: /use this folder/i }),
    );

    expect(localStorage.getItem(DOWNLOADS_DEFAULT_FOLDER_KEY)).toBe(
      EXPECTED_PREFILL,
    );
    expect(getDefaultFolder()).toBe(EXPECTED_PREFILL);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(EXPECTED_PREFILL);
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

  it("on modal commit, dispatches the deferred download against the now-set folder", async () => {
    installApiMock();
    const onDispatch = vi.fn();
    render(<TriggerHarness onDispatch={onDispatch} />);

    fireEvent.click(
      screen.getByRole("button", { name: /trigger download/i }),
    );
    // Wait for the modal's OS-default-folder pre-fill to land before
    // committing — the post-archive bug fix gates the CTA on a non-empty
    // folder string so the user can't ship the placeholder.
    const cta = screen.getByRole("button", { name: /use this folder/i });
    await waitFor(() => expect(cta).not.toBeDisabled());
    fireEvent.click(cta);

    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch).toHaveBeenCalledWith(EXPECTED_PREFILL);
    expect(getDefaultFolder()).toBe(EXPECTED_PREFILL);
  });
});
