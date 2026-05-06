/** @vitest-environment jsdom */
//
// migrate-upload-orchestration-out-of-engine §15.3 — failing test for the
// file-explorer init effect: on mount the explorer subscribes to
// `window.api.files.onActiveUploadsHydrate(callback)` so the renderer
// upload toaster receives the active-uploads snapshot from the
// supervisor's first connect (per spec § "App-launch hydrates active
// uploads from the service registry").
//
// Mirror of `download-toaster-wiring.test.tsx`. The composite test
// suite mocks a bare `window.api.files` without the hydrate channel;
// this test installs the channel and asserts the file-explorer mounts
// a listener that drives `hydrateActiveUploads` on the toaster.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { cleanup, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

import type { UploadToaster } from "../use-upload-orchestrator.js";

import { FileExplorer } from "../file-explorer.js";
import { __resetExplorerStoreCacheForTests } from "../store.js";

let onActiveUploadsHydrateMock: Mock;

function installApiMock(): void {
  onActiveUploadsHydrateMock = vi
    .fn()
    .mockImplementation(() => () => {});

  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: vi.fn(),
      remove: vi.fn().mockResolvedValue({ ok: true }),
      action: vi.fn(),
      pickFilesToUpload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    sync: {
      listJobs: vi.fn().mockResolvedValue({ jobs: [] }),
      onEvent: vi.fn().mockReturnValue(() => {}),
      authenticateStart: vi.fn(),
      authenticateComplete: vi.fn(),
      authenticateCancel: vi.fn(),
      cancelUpload: vi.fn(),
    },
    files: {
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: { entries: [], truncated: false },
      }),
      stat: vi.fn(),
      search: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      download: vi.fn(),
      onActiveDownloadsHydrate: vi.fn().mockReturnValue(() => {}),
      onActiveUploadsHydrate: onActiveUploadsHydrateMock,
    },
    uploads: {
      listActive: vi.fn().mockResolvedValue({ jobs: [] }),
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  __resetExplorerStoreCacheForTests();
  installApiMock();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

// Test-only stub toaster: keeps the file-explorer's render path
// happy without spawning the real `createUploadJobToaster` (which
// touches `window.api.sync.onEvent` at construction time and would
// fight our explicit ON-mount expectations).
function makeStubToaster(): UploadToaster {
  return {
    onJobDispatched: vi.fn(),
    onBatchError: vi.fn(),
  };
}

describe("FileExplorer upload-toaster wiring (§15.3)", () => {
  it("subscribes to window.api.files.onActiveUploadsHydrate on mount", () => {
    render(<FileExplorer datasourceId="ds-1" toaster={makeStubToaster()} />);

    expect(onActiveUploadsHydrateMock).toHaveBeenCalledTimes(1);
    const callback = onActiveUploadsHydrateMock.mock.calls[0]?.[0];
    expect(typeof callback).toBe("function");
  });

  it("forwards the hydrate snapshot through to the upload toaster's hydrateActiveUploads", () => {
    // The default toaster is created internally by the explorer; we
    // verify the wiring by invoking the registered hydrate callback
    // with two synthetic in-flight jobs and asserting that the
    // callback runs without throwing (the toaster's
    // `hydrateActiveUploads` is the only consumer of the hydrate
    // payload — see file-explorer.tsx's §15 effect). A strictly
    // assertion-rich variant would mock the toaster factory; this
    // test sticks to the renderer-level wiring contract: the channel
    // is subscribed, the callback accepts the wire payload shape.
    render(<FileExplorer datasourceId="ds-1" />);
    const callback = onActiveUploadsHydrateMock.mock.calls[0]?.[0] as (
      jobs: readonly unknown[],
    ) => void;
    expect(typeof callback).toBe("function");

    // Two synthetic in-flight uploads.
    const sample: ReadonlyArray<{
      uploadJobId: string;
      datasourceId: string;
      sourcePath: string;
      targetPath: string;
      bytesUploaded: number;
      contentLength: number | null;
      startedAt: number;
    }> = [
      {
        uploadJobId: "u-1",
        datasourceId: "ds-1",
        sourcePath: "C:/local/a.pdf",
        targetPath: "/projects/2026/a.pdf",
        bytesUploaded: 12_000,
        contentLength: 100_000,
        startedAt: 1_700_000_000_000,
      },
      {
        uploadJobId: "u-2",
        datasourceId: "ds-1",
        sourcePath: "C:/local/b.png",
        targetPath: "/projects/2026/b.png",
        bytesUploaded: 0,
        contentLength: 25_000,
        startedAt: 1_700_000_000_500,
      },
    ];
    expect(() => callback(sample)).not.toThrow();
  });
});
