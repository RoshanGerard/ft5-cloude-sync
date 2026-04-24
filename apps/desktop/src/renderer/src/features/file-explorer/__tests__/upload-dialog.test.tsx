/** @vitest-environment jsdom */
//
// UploadDialog — unit tests. Covers Task 6.1 scenarios:
//   (a) opens with destination = currentPath when opened from explorer
//   (b) opens with destination = "/" when opened from card
//   (c) "+ Add files…" calls pickFilesToUpload, appends to list
//   (d) directory tree shows only kind === "directory" entries
//   (e) single-click on a directory row navigates INTO it, updating
//       destination path, breadcrumb, footer, and primary-button label
//   (f) click on the ".." parent row navigates UP
//   (g) click on a breadcrumb segment jumps to that segment
//   (h) primary button disabled when Files list is empty
//   (i) submit dispatches orchestrator with targetDir = current folder
//       and closes the dialog
//
// Mock patterns mirror drop-zone.test.tsx:
//   - vi.mock on "sonner" so toaster stubs are observable.
//   - vi.mock on "../use-upload-orchestrator.js" so we can assert on
//     the factory args without exercising the real stat/upload plumbing.
//   - window.api stubbed globally (files.list, datasources.pickFilesToUpload).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { FileEntry } from "@ft5/ipc-contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const startMock = vi.fn(async () => {});
const createUploadOrchestratorMock = vi.fn(() => ({ start: startMock }));

vi.mock("../use-upload-orchestrator.js", () => ({
  createUploadOrchestrator: (...args: unknown[]) =>
    createUploadOrchestratorMock(...(args as [])),
}));

import { UploadDialog } from "../upload-dialog.js";
import type {
  ConflictResolver,
  UploadToaster,
} from "../use-upload-orchestrator.js";

// Helper — build FileEntry fixtures compact for destination-tree listings.
interface EntryInit {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file";
}
function makeEntry(init: EntryInit): FileEntry {
  return {
    id: init.id,
    kind: init.kind,
    name: init.name,
    path: init.path,
    parentPath: init.path.split("/").slice(0, -1).join("/") || "/",
    size: init.kind === "directory" ? null : 100,
    mimeFamily: init.kind === "directory" ? "unknown" : "text",
    mimeType: init.kind === "directory" ? null : "text/plain",
    modifiedAt: "2026-04-01T00:00:00Z",
    createdAt: null,
    providerMetadata: {},
  };
}

// Per-path stub: tests override with `setListing(path, entries)`.
const listByPath = new Map<string, FileEntry[]>();

let filesListMock: Mock;
let pickFilesMock: Mock;

function resetApiMocks(): void {
  listByPath.clear();
  filesListMock = vi.fn(async (req: { path: string }) => ({
    ok: true as const,
    value: {
      entries: listByPath.get(req.path) ?? [],
      truncated: false,
    },
  }));
  pickFilesMock = vi.fn(async () => ({
    filePaths: [] as readonly string[],
    canceled: false,
  }));
  (window as unknown as { api: unknown }).api = {
    files: {
      list: filesListMock,
      stat: vi.fn(),
      upload: vi.fn(),
    },
    datasources: {
      pickFilesToUpload: pickFilesMock,
    },
  };
}

function setListing(path: string, entries: FileEntry[]): void {
  listByPath.set(path, entries);
}

function makeResolver(): ConflictResolver {
  return { resolve: vi.fn(async () => ({ aborted: false, choices: [] })) };
}

function makeToaster(): UploadToaster {
  return { onJobDispatched: vi.fn(), onBatchError: vi.fn() };
}

// Controlled render helper. Gives caller a handle to flip `open` from the
// outside (cards + toolbar are the production controllers).
interface RenderOpts {
  readonly initialDestination?: string;
  readonly datasourceId?: string;
  readonly datasourceName?: string;
  readonly conflictResolver?: ConflictResolver;
  readonly toaster?: UploadToaster;
}
function renderDialog(opts: RenderOpts = {}): {
  conflictResolver: ConflictResolver;
  toaster: UploadToaster;
  onOpenChange: Mock;
} {
  const conflictResolver = opts.conflictResolver ?? makeResolver();
  const toaster = opts.toaster ?? makeToaster();
  const onOpenChange = vi.fn();
  render(
    <UploadDialog
      open
      onOpenChange={onOpenChange}
      datasourceId={opts.datasourceId ?? "ds-1"}
      datasourceName={opts.datasourceName ?? "Test Drive"}
      initialDestination={opts.initialDestination ?? "/"}
      conflictResolver={conflictResolver}
      toaster={toaster}
    />,
  );
  return { conflictResolver, toaster, onOpenChange };
}

beforeEach(() => {
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
  resetApiMocks();
  startMock.mockClear();
  createUploadOrchestratorMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("UploadDialog — destination defaults", () => {
  it("(a) opens with destination = initialDestination when opened from explorer", async () => {
    setListing("/projects/2026", [
      makeEntry({
        id: "d1",
        name: "drafts",
        path: "/projects/2026/drafts",
        kind: "directory",
      }),
    ]);
    renderDialog({ initialDestination: "/projects/2026" });

    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalledWith({
        datasourceId: "ds-1",
        path: "/projects/2026",
      });
    });
    // Footer + primary-button both display the current destination live.
    expect(
      screen.getByTestId("upload-dialog-destination-footer"),
    ).toHaveTextContent("→ /projects/2026");
    expect(
      screen.getByTestId("upload-dialog-submit"),
    ).toHaveTextContent(/\/projects\/2026/);
  });

  it("(b) opens with destination = '/' when opened from card", async () => {
    setListing("/", [
      makeEntry({ id: "d1", name: "projects", path: "/projects", kind: "directory" }),
    ]);
    renderDialog({ initialDestination: "/" });

    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalledWith({
        datasourceId: "ds-1",
        path: "/",
      });
    });
    expect(
      screen.getByTestId("upload-dialog-destination-footer"),
    ).toHaveTextContent("→ /");
  });
});

describe("UploadDialog — files section", () => {
  it("(c) '+ Add files…' calls pickFilesToUpload and appends the paths to the list", async () => {
    pickFilesMock = vi.fn(async () => ({
      filePaths: ["C:/tmp/a.pdf", "C:/tmp/b.png"],
      canceled: false,
    }));
    (window as unknown as { api: { datasources: { pickFilesToUpload: Mock } } }).api.datasources.pickFilesToUpload = pickFilesMock;

    setListing("/", []);
    renderDialog({ initialDestination: "/" });

    const addBtn = screen.getByTestId("upload-dialog-add-files");
    await act(async () => {
      fireEvent.click(addBtn);
    });

    expect(pickFilesMock).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      const rows = screen.getAllByTestId("upload-dialog-file-row");
      expect(rows).toHaveLength(2);
    });
    const rowTexts = screen
      .getAllByTestId("upload-dialog-file-row")
      .map((r) => r.textContent ?? "");
    expect(rowTexts.some((t) => t.includes("a.pdf"))).toBe(true);
    expect(rowTexts.some((t) => t.includes("b.png"))).toBe(true);

    // A second pick appends rather than replacing — spec line 99.
    pickFilesMock.mockResolvedValueOnce({
      filePaths: ["C:/tmp/c.txt"],
      canceled: false,
    });
    await act(async () => {
      fireEvent.click(addBtn);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("upload-dialog-file-row")).toHaveLength(3);
    });
  });
});

describe("UploadDialog — destination tree", () => {
  it("(d) directory tree renders ONLY kind === 'directory' entries from files.list", async () => {
    setListing("/", [
      makeEntry({ id: "d1", name: "projects", path: "/projects", kind: "directory" }),
      makeEntry({ id: "d2", name: "docs", path: "/docs", kind: "directory" }),
      makeEntry({ id: "f1", name: "readme.md", path: "/readme.md", kind: "file" }),
      makeEntry({ id: "f2", name: "photo.png", path: "/photo.png", kind: "file" }),
    ]);
    renderDialog({ initialDestination: "/" });

    await waitFor(() => {
      const rows = screen.getAllByTestId("upload-dialog-dir-row");
      expect(rows).toHaveLength(2);
    });
    const names = screen
      .getAllByTestId("upload-dialog-dir-row")
      .map((r) => r.textContent ?? "");
    expect(names.some((n) => n.includes("projects"))).toBe(true);
    expect(names.some((n) => n.includes("docs"))).toBe(true);
    // File entries must not appear anywhere in the destination list.
    for (const n of names) {
      expect(n).not.toMatch(/readme\.md/);
      expect(n).not.toMatch(/photo\.png/);
    }
  });

  it("(e) single-click on a directory row navigates INTO it and updates path + breadcrumb + footer + button label", async () => {
    setListing("/projects/2026", [
      makeEntry({
        id: "d1",
        name: "drafts",
        path: "/projects/2026/drafts",
        kind: "directory",
      }),
    ]);
    setListing("/projects/2026/drafts", []);
    renderDialog({ initialDestination: "/projects/2026" });

    await waitFor(() => {
      expect(screen.getAllByTestId("upload-dialog-dir-row")).toHaveLength(1);
    });
    const draftsRow = screen.getAllByTestId("upload-dialog-dir-row")[0];
    expect(draftsRow).toBeDefined();
    fireEvent.click(draftsRow!);

    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalledWith({
        datasourceId: "ds-1",
        path: "/projects/2026/drafts",
      });
    });
    expect(
      screen.getByTestId("upload-dialog-destination-footer"),
    ).toHaveTextContent("→ /projects/2026/drafts");
    expect(
      screen.getByTestId("upload-dialog-submit"),
    ).toHaveTextContent(/\/projects\/2026\/drafts/);
    // Breadcrumb shows all four segments for /projects/2026/drafts.
    const breadcrumb = screen.getByTestId("upload-dialog-breadcrumb");
    expect(breadcrumb.textContent ?? "").toMatch(/root/);
    expect(breadcrumb.textContent ?? "").toMatch(/projects/);
    expect(breadcrumb.textContent ?? "").toMatch(/2026/);
    expect(breadcrumb.textContent ?? "").toMatch(/drafts/);
  });

  it("(f) click on the '.. (parent)' row navigates UP one level", async () => {
    setListing("/projects/2026", []);
    setListing("/projects", []);
    renderDialog({ initialDestination: "/projects/2026" });

    await waitFor(() => {
      expect(screen.queryByTestId("upload-dialog-parent-row")).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId("upload-dialog-parent-row"));

    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalledWith({
        datasourceId: "ds-1",
        path: "/projects",
      });
    });
    expect(
      screen.getByTestId("upload-dialog-destination-footer"),
    ).toHaveTextContent("→ /projects");
  });

  it("synthesized '.. (parent)' row is NOT shown at root", async () => {
    setListing("/", []);
    renderDialog({ initialDestination: "/" });

    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("upload-dialog-parent-row")).toBeNull();
  });

  it("(g) click on a breadcrumb segment jumps to that segment", async () => {
    setListing("/projects/2026/drafts", []);
    setListing("/projects", []);
    renderDialog({ initialDestination: "/projects/2026/drafts" });

    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalledWith({
        datasourceId: "ds-1",
        path: "/projects/2026/drafts",
      });
    });

    // Find the `projects` segment button inside the dialog breadcrumb.
    const breadcrumb = screen.getByTestId("upload-dialog-breadcrumb");
    const projectsBtn = Array.from(
      breadcrumb.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => (b.textContent ?? "").trim() === "projects");
    expect(projectsBtn).toBeDefined();
    fireEvent.click(projectsBtn!);

    await waitFor(() => {
      expect(filesListMock).toHaveBeenCalledWith({
        datasourceId: "ds-1",
        path: "/projects",
      });
    });
    expect(
      screen.getByTestId("upload-dialog-destination-footer"),
    ).toHaveTextContent("→ /projects");
  });
});

describe("UploadDialog — submit", () => {
  it("(h) primary button is disabled while the Files list is empty", async () => {
    setListing("/", []);
    renderDialog({ initialDestination: "/" });

    const submit = screen.getByTestId("upload-dialog-submit");
    expect(submit).toBeDisabled();
    expect(submit.textContent ?? "").toMatch(/0 files/);
  });

  it("(i) submit dispatches the orchestrator with targetDir = currently-displayed folder, then closes the dialog", async () => {
    pickFilesMock = vi.fn(async () => ({
      filePaths: ["C:/tmp/a.pdf"],
      canceled: false,
    }));
    (window as unknown as { api: { datasources: { pickFilesToUpload: Mock } } }).api.datasources.pickFilesToUpload = pickFilesMock;

    setListing("/projects/2026", [
      makeEntry({
        id: "d1",
        name: "drafts",
        path: "/projects/2026/drafts",
        kind: "directory",
      }),
    ]);
    setListing("/projects/2026/drafts", []);
    const { onOpenChange } = renderDialog({
      initialDestination: "/projects/2026",
      datasourceId: "ds-xyz",
    });

    // Add a file, navigate into drafts, submit.
    await act(async () => {
      fireEvent.click(screen.getByTestId("upload-dialog-add-files"));
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("upload-dialog-file-row")).toHaveLength(1);
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("upload-dialog-dir-row")).toHaveLength(1);
    });
    const draftsRow = screen.getAllByTestId("upload-dialog-dir-row")[0];
    fireEvent.click(draftsRow!);

    await waitFor(() => {
      expect(
        screen.getByTestId("upload-dialog-destination-footer"),
      ).toHaveTextContent("→ /projects/2026/drafts");
    });

    // Submit. Primary button should now be enabled.
    const submit = screen.getByTestId("upload-dialog-submit");
    expect(submit).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(submit);
    });

    expect(createUploadOrchestratorMock).toHaveBeenCalledTimes(1);
    const arg = createUploadOrchestratorMock.mock.calls[0]?.[0] as {
      datasourceId: string;
      targetDir: string;
      files: ReadonlyArray<{ sourcePath: string; basename: string; sizeBytes: number }>;
    };
    expect(arg.datasourceId).toBe("ds-xyz");
    expect(arg.targetDir).toBe("/projects/2026/drafts");
    expect(arg.files).toHaveLength(1);
    expect(arg.files[0]?.sourcePath).toBe("C:/tmp/a.pdf");
    expect(arg.files[0]?.basename).toBe("a.pdf");
    expect(startMock).toHaveBeenCalledTimes(1);

    // Dialog closes after dispatch — onOpenChange(false) fired.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
