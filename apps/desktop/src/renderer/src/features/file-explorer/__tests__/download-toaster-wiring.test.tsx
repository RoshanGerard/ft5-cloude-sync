/** @vitest-environment jsdom */
//
// add-engine-rename-download §24.4 — failing test for the file-explorer
// init effect: on mount the explorer subscribes to
// `window.api.files.onActiveDownloadsHydrate(callback)` so the renderer
// download toaster receives the active-downloads snapshot from the
// supervisor's first connect (per spec § "App-launch hydrates active
// downloads from the service registry").
//
// The composite test suite mocks a bare `window.api.files` without the
// hydrate channel; this test installs the channel and asserts the
// file-explorer mounts a listener.

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

import { FileExplorer } from "../file-explorer.js";
import { __resetExplorerStoreCacheForTests } from "../store.js";

let onActiveDownloadsHydrateMock: Mock;

function installApiMock(): void {
  onActiveDownloadsHydrateMock = vi
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
      onActiveDownloadsHydrate: onActiveDownloadsHydrateMock,
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

describe("FileExplorer download-toaster wiring (§24.4)", () => {
  it("subscribes to window.api.files.onActiveDownloadsHydrate on mount", () => {
    render(<FileExplorer datasourceId="ds-1" />);

    expect(onActiveDownloadsHydrateMock).toHaveBeenCalledTimes(1);
    const callback = onActiveDownloadsHydrateMock.mock.calls[0]?.[0];
    expect(typeof callback).toBe("function");
  });
});
