/** @vitest-environment jsdom */
//
// Phase 5 code-review fix (I1 + I2) — DatasourcesProvider unmount guard.
//
// The provider's `refresh()` and mutation callbacks all `await` on
// `window.api.datasources.*` before dispatching. If the provider unmounts
// between the await and the dispatch, the dispatch must be a no-op — otherwise
// React 19 surfaces the classic "setState on unmounted component" warning and
// strict-mode double-mounts can race two in-flight `list()` resolutions.

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
import type { DatasourceSummary } from "@ft5/ipc-contracts";

import { DatasourcesProvider } from "../store";

type PromiseController<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function createController<T>(): PromiseController<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let listMock: Mock;

function installApiMock() {
  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: listMock,
      add: vi.fn(),
      remove: vi.fn(),
      action: vi.fn(),
      upload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
    },
  };
}

describe("DatasourcesProvider — post-unmount dispatch guard", () => {
  beforeEach(() => {
    listMock = vi.fn();
    installApiMock();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not warn when list() resolves after the provider unmounts", async () => {
    const controller = createController<{ datasources: DatasourceSummary[] }>();
    listMock.mockReturnValue(controller.promise);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(
      <DatasourcesProvider>
        <div>child</div>
      </DatasourcesProvider>,
    );

    // Unmount before the list() promise resolves.
    unmount();

    // Now resolve. The mount sentinel should short-circuit the dispatch.
    controller.resolve({ datasources: [] });
    await controller.promise;
    // Flush microtasks queued after the await.
    await Promise.resolve();
    await Promise.resolve();

    // No React "setState on unmounted" / act warnings.
    const reactWarnings = errorSpy.mock.calls.filter((args) => {
      const first = args[0];
      if (typeof first !== "string") return false;
      return (
        /unmounted component/i.test(first) ||
        /not wrapped in act/i.test(first) ||
        /state update on an unmounted/i.test(first)
      );
    });
    expect(reactWarnings).toEqual([]);
  });

  it("does not warn when list() rejects after the provider unmounts", async () => {
    const controller = createController<{ datasources: DatasourceSummary[] }>();
    listMock.mockReturnValue(controller.promise);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(
      <DatasourcesProvider>
        <div>child</div>
      </DatasourcesProvider>,
    );

    unmount();

    controller.reject(new Error("network gone"));
    // Let the rejection propagate without crashing the test.
    await controller.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    const reactWarnings = errorSpy.mock.calls.filter((args) => {
      const first = args[0];
      if (typeof first !== "string") return false;
      return (
        /unmounted component/i.test(first) ||
        /not wrapped in act/i.test(first) ||
        /state update on an unmounted/i.test(first)
      );
    });
    expect(reactWarnings).toEqual([]);
  });
});
