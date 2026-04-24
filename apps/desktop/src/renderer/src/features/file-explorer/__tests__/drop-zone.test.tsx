/** @vitest-environment jsdom */
//
// DropZone — unit tests. Covers Task 5.1 scenarios:
//   (a) dragover with `dataTransfer.types` including "Files" activates
//       the overlay
//   (b) dragover without "Files" does not activate
//   (c) drop dispatches the orchestrator with `targetDir = currentPath`
//   (d) drop of a folder shows the toast and dispatches zero uploads
//   (e) mixed file+folder drop dispatches only the files
//   (f) drop while datasource is blocked renders blocked overlay, drop is
//       a no-op (also covers auth-revoked and syncing)
//
// Mocks:
//   - sonner's `toast.info` so we can observe the folder-drop message
//     without mounting a <Toaster/>.
//   - `use-upload-orchestrator` so we can assert which args reach the
//     orchestrator without exercising the real stat/upload plumbing.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("sonner", () => ({
  toast: {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const startMock = vi.fn(async () => {});
const useUploadOrchestratorMock = vi.fn(() => ({ start: startMock }));

vi.mock("../use-upload-orchestrator.js", () => ({
  useUploadOrchestrator: (...args: unknown[]) =>
    useUploadOrchestratorMock(...(args as [])),
}));

import { toast } from "sonner";
import { DropZone, type DropZoneStatus } from "../drop-zone.js";
import type {
  ConflictResolver,
  UploadToaster,
} from "../use-upload-orchestrator.js";

// JSDOM doesn't model DataTransfer with items/webkitGetAsEntry. Build a
// minimal fake that mirrors the parts `drop-zone.tsx` actually touches.

interface FakeFileInit {
  readonly name: string;
  readonly size: number;
  readonly path: string;
}

function fakeFile(init: FakeFileInit): File {
  const f = new File([new Uint8Array(init.size)], init.name);
  // Electron augments File with `.path`; mimic that in tests.
  Object.defineProperty(f, "path", { value: init.path, writable: false });
  return f;
}

interface FakeItemInit {
  readonly kind: "file";
  readonly file: File | null;
  readonly isDirectory: boolean;
}

function fakeDataTransfer(items: readonly FakeItemInit[]): DataTransfer {
  const fakeItems = items.map((init) => ({
    kind: init.kind,
    type: init.file ? "application/octet-stream" : "",
    getAsFile: () => init.file,
    webkitGetAsEntry: () => ({
      isFile: !init.isDirectory,
      isDirectory: init.isDirectory,
    }),
  }));
  const files = items
    .filter((i) => !i.isDirectory && i.file !== null)
    .map((i) => i.file as File);
  return {
    types: ["Files"],
    items: fakeItems as unknown as DataTransferItemList,
    files: {
      length: files.length,
      item: (i: number) => files[i] ?? null,
      [Symbol.iterator]: function* () {
        for (const f of files) yield f;
      },
    } as unknown as FileList,
  } as unknown as DataTransfer;
}

function nonFileDataTransfer(): DataTransfer {
  return {
    types: ["text/plain"],
    items: [] as unknown as DataTransferItemList,
    files: { length: 0, item: () => null } as unknown as FileList,
  } as unknown as DataTransfer;
}

function renderDropZone(
  overrides: Partial<{
    status: DropZoneStatus;
    currentPath: string;
    datasourceId: string;
  }> = {},
) {
  const conflictResolver: ConflictResolver = {
    resolve: vi.fn(async () => ({ aborted: false, choices: [] })),
  };
  const toaster: UploadToaster = {
    onJobDispatched: vi.fn(),
    onBatchError: vi.fn(),
  };
  render(
    <DropZone
      datasourceId={overrides.datasourceId ?? "ds-1"}
      currentPath={overrides.currentPath ?? "/projects/2026"}
      status={overrides.status ?? "usable"}
      conflictResolver={conflictResolver}
      toaster={toaster}
    >
      <div data-testid="inner-child">children</div>
    </DropZone>,
  );
  return { conflictResolver, toaster };
}

beforeEach(() => {
  startMock.mockClear();
  useUploadOrchestratorMock.mockClear();
  (toast.info as Mock).mockClear();
});

afterEach(() => {
  cleanup();
});

describe("DropZone — overlay activation", () => {
  it('activates the active overlay on dragover with dataTransfer.types including "Files"', () => {
    renderDropZone();
    expect(screen.queryByTestId("drop-overlay-active")).toBeNull();

    const zone = screen.getByTestId("drop-zone");
    fireEvent.dragEnter(zone, { dataTransfer: fakeDataTransfer([]) });
    fireEvent.dragOver(zone, { dataTransfer: fakeDataTransfer([]) });

    const overlay = screen.getByTestId("drop-overlay-active");
    expect(overlay).toBeInTheDocument();
    expect(screen.getByText("→ /projects/2026")).toBeInTheDocument();
  });

  it('does NOT activate the overlay on dragover without "Files" in types', () => {
    renderDropZone();
    const zone = screen.getByTestId("drop-zone");
    fireEvent.dragEnter(zone, { dataTransfer: nonFileDataTransfer() });
    fireEvent.dragOver(zone, { dataTransfer: nonFileDataTransfer() });

    expect(screen.queryByTestId("drop-overlay-active")).toBeNull();
    expect(screen.queryByTestId("drop-overlay-blocked")).toBeNull();
  });

  it("hides the overlay once dragleave brings the enter-count back to zero", () => {
    renderDropZone();
    const zone = screen.getByTestId("drop-zone");
    fireEvent.dragEnter(zone, { dataTransfer: fakeDataTransfer([]) });
    expect(screen.getByTestId("drop-overlay-active")).toBeInTheDocument();
    fireEvent.dragLeave(zone, { dataTransfer: fakeDataTransfer([]) });
    expect(screen.queryByTestId("drop-overlay-active")).toBeNull();
  });
});

describe("DropZone — drop dispatching", () => {
  it("drop of N files instantiates the orchestrator with targetDir = currentPath and calls start()", () => {
    const { conflictResolver, toaster } = renderDropZone({
      currentPath: "/projects/2026",
      datasourceId: "ds-xyz",
    });
    const zone = screen.getByTestId("drop-zone");
    const dt = fakeDataTransfer([
      {
        kind: "file",
        file: fakeFile({ name: "a.pdf", size: 100, path: "C:/local/a.pdf" }),
        isDirectory: false,
      },
      {
        kind: "file",
        file: fakeFile({ name: "b.png", size: 200, path: "C:/local/b.png" }),
        isDirectory: false,
      },
    ]);
    fireEvent.dragEnter(zone, { dataTransfer: dt });
    fireEvent.drop(zone, { dataTransfer: dt });

    expect(useUploadOrchestratorMock).toHaveBeenCalledTimes(1);
    const arg = useUploadOrchestratorMock.mock.calls[0]?.[0] as {
      datasourceId: string;
      targetDir: string;
      files: Array<{ sourcePath: string; basename: string; sizeBytes: number }>;
      conflictResolver: ConflictResolver;
      toaster: UploadToaster;
    };
    expect(arg.datasourceId).toBe("ds-xyz");
    expect(arg.targetDir).toBe("/projects/2026");
    expect(arg.conflictResolver).toBe(conflictResolver);
    expect(arg.toaster).toBe(toaster);
    expect(arg.files).toHaveLength(2);
    expect(arg.files[0]).toEqual({
      sourcePath: "C:/local/a.pdf",
      basename: "a.pdf",
      sizeBytes: 100,
    });
    expect(arg.files[1]).toEqual({
      sourcePath: "C:/local/b.png",
      basename: "b.png",
      sizeBytes: 200,
    });
    expect(startMock).toHaveBeenCalledTimes(1);
    // Overlay disappears on drop.
    expect(screen.queryByTestId("drop-overlay-active")).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("drop of a folder only shows the folder-upload toast and dispatches zero uploads", () => {
    renderDropZone();
    const zone = screen.getByTestId("drop-zone");
    const dt = fakeDataTransfer([
      { kind: "file", file: null, isDirectory: true },
    ]);
    fireEvent.drop(zone, { dataTransfer: dt });

    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(
      "Folder upload is coming soon — drop individual files for now",
    );
    expect(useUploadOrchestratorMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("mixed file+folder drop dispatches ONLY the files and fires the folder toast once", () => {
    renderDropZone({ currentPath: "/docs" });
    const zone = screen.getByTestId("drop-zone");
    const dt = fakeDataTransfer([
      {
        kind: "file",
        file: fakeFile({ name: "ok.txt", size: 10, path: "C:/ok.txt" }),
        isDirectory: false,
      },
      { kind: "file", file: null, isDirectory: true },
      {
        kind: "file",
        file: fakeFile({ name: "ok2.txt", size: 20, path: "C:/ok2.txt" }),
        isDirectory: false,
      },
    ]);
    fireEvent.drop(zone, { dataTransfer: dt });

    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(useUploadOrchestratorMock).toHaveBeenCalledTimes(1);
    const arg = useUploadOrchestratorMock.mock.calls[0]?.[0] as {
      targetDir: string;
      files: Array<{ sourcePath: string; basename: string; sizeBytes: number }>;
    };
    expect(arg.targetDir).toBe("/docs");
    expect(arg.files).toHaveLength(2);
    expect(arg.files.map((f) => f.basename).sort()).toEqual(["ok.txt", "ok2.txt"]);
    expect(startMock).toHaveBeenCalledTimes(1);
  });
});

describe("DropZone — blocked states", () => {
  it("renders the blocked overlay with the disconnected reason on dragover", () => {
    renderDropZone({ status: "disconnected" });
    const zone = screen.getByTestId("drop-zone");
    fireEvent.dragEnter(zone, { dataTransfer: fakeDataTransfer([]) });

    const overlay = screen.getByTestId("drop-overlay-blocked");
    expect(overlay).toHaveAttribute("data-blocked-reason", "disconnected");
    expect(screen.queryByTestId("drop-overlay-active")).toBeNull();
  });

  it("drop on disconnected datasource is a no-op: no toast, no orchestrator dispatch", () => {
    renderDropZone({ status: "disconnected" });
    const zone = screen.getByTestId("drop-zone");
    const dt = fakeDataTransfer([
      {
        kind: "file",
        file: fakeFile({ name: "a.txt", size: 1, path: "C:/a.txt" }),
        isDirectory: false,
      },
    ]);
    fireEvent.dragEnter(zone, { dataTransfer: dt });
    fireEvent.drop(zone, { dataTransfer: dt });

    expect(useUploadOrchestratorMock).not.toHaveBeenCalled();
    expect(startMock).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("renders the blocked overlay for auth-revoked", () => {
    renderDropZone({ status: "auth-revoked" });
    const zone = screen.getByTestId("drop-zone");
    fireEvent.dragEnter(zone, { dataTransfer: fakeDataTransfer([]) });
    const overlay = screen.getByTestId("drop-overlay-blocked");
    expect(overlay).toHaveAttribute("data-blocked-reason", "auth-revoked");
  });

  it("renders the blocked overlay for syncing", () => {
    renderDropZone({ status: "syncing" });
    const zone = screen.getByTestId("drop-zone");
    fireEvent.dragEnter(zone, { dataTransfer: fakeDataTransfer([]) });
    const overlay = screen.getByTestId("drop-overlay-blocked");
    expect(overlay).toHaveAttribute("data-blocked-reason", "syncing");
  });
});
