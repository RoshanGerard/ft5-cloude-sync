/** @vitest-environment jsdom */
// Task 6.11 / 6.12 — pending-op + error-pin row visuals and Details-pane
// slide animation. Covers the deltas that the existing view-mode suites
// don't (remove-by-path pendingOps, line-through on remove, error-pin
// when `lastError.entryId` matches, details-pane `data-state` mount).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { DetailsPane } from "../details-pane.js";
import {
  entryError,
  entryPendingOp,
} from "../pending-op-state.js";
import {
  __resetExplorerStoreCacheForTests,
  createExplorerStore,
} from "../store.js";
import type { ExplorerStore } from "../store.js";
import { DetailsView } from "../view-modes/details.js";
import { seedEntry } from "./test-utils.js";

function makeStore(id = "ds-pending-op-visuals"): ExplorerStore {
  return createExplorerStore(id);
}

describe("pending-op-state helper", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => cleanup());

  it("entryPendingOp returns the id-keyed op (rename case)", () => {
    const store = makeStore();
    const entry = seedEntry({ id: "e1", path: "/x.txt" });
    act(() => {
      store.setEntries([entry]);
      store.startPendingOp("e1", "rename");
    });
    const state = store.getSnapshot();
    const op = entryPendingOp(state, entry);
    expect(op?.kind).toBe("rename");
  });

  it("entryPendingOp returns the path-keyed op (remove case)", () => {
    const store = makeStore();
    const entry = seedEntry({ id: "e1", path: "/x.txt" });
    act(() => {
      store.setEntries([entry]);
      // remove seeds pendingOps by PATH per store.ts contract.
      store.startPendingOp("/x.txt", "remove");
    });
    const state = store.getSnapshot();
    const op = entryPendingOp(state, entry);
    expect(op?.kind).toBe("remove");
  });

  it("entryPendingOp returns null when no op matches", () => {
    const store = makeStore();
    const entry = seedEntry({ id: "e1", path: "/x.txt" });
    act(() => {
      store.setEntries([entry]);
    });
    expect(entryPendingOp(store.getSnapshot(), entry)).toBeNull();
  });

  it("entryError returns reason when lastError.entryId matches", () => {
    const store = makeStore();
    const entry = seedEntry({ id: "e1", path: "/x.txt" });
    act(() => {
      store.setEntries([entry]);
      store.setLastError("e1", "provider locked the file");
    });
    expect(entryError(store.getSnapshot(), entry)).toBe(
      "provider locked the file",
    );
  });

  it("entryError returns null when lastError is for a different entry", () => {
    const store = makeStore();
    const entry = seedEntry({ id: "e1", path: "/x.txt" });
    act(() => {
      store.setEntries([entry]);
      store.setLastError("e2", "nope");
    });
    expect(entryError(store.getSnapshot(), entry)).toBeNull();
  });
});

describe("DetailsView — pending-op by path (remove)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => cleanup());

  it("row renders opacity-60 + pulse glyph when pendingOps[entry.path].kind === 'remove'", () => {
    const store = makeStore();
    const a = seedEntry({ id: "e1", name: "doomed.txt", path: "/doomed.txt" });
    const b = seedEntry({ id: "e2", name: "safe.txt", path: "/safe.txt" });
    act(() => {
      store.setEntries([a, b]);
      // remove keys by path — the row must still pick this up.
      store.startPendingOp("/doomed.txt", "remove");
    });
    render(<DetailsView store={store} />);
    const rows = screen.getAllByTestId("explorer-row");
    const doomed = rows.find((r) => r.getAttribute("data-entry-id") === "e1");
    const safe = rows.find((r) => r.getAttribute("data-entry-id") === "e2");
    expect(doomed!.className).toMatch(/\bopacity-60\b/);
    const pulse = within(doomed!).getByTestId("explorer-pending-glyph");
    expect(pulse.className).toMatch(/\banimate-sync-pulse\b/);
    expect(safe!.className).not.toMatch(/\bopacity-60\b/);
  });

  it("name cell is line-through while a remove is in flight", () => {
    const store = makeStore();
    const e = seedEntry({ id: "e1", name: "doomed.txt", path: "/doomed.txt" });
    act(() => {
      store.setEntries([e]);
      store.startPendingOp("/doomed.txt", "remove");
    });
    render(<DetailsView store={store} />);
    const nameCell = screen.getByTestId("explorer-cell-name");
    expect(nameCell.className).toMatch(/\bline-through\b/);
  });

  it("rename pendingOp does NOT apply line-through", () => {
    const store = makeStore();
    const e = seedEntry({ id: "e1", name: "old.txt", path: "/old.txt" });
    act(() => {
      store.setEntries([e]);
      store.startPendingOp("e1", "rename");
    });
    render(<DetailsView store={store} />);
    const nameCell = screen.getByTestId("explorer-cell-name");
    expect(nameCell.className).not.toMatch(/\bline-through\b/);
  });
});

describe("DetailsView — error pin", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => cleanup());

  it("renders an error glyph with the reason as title/aria-label when lastError.entryId matches", () => {
    const store = makeStore();
    const e = seedEntry({ id: "e1", name: "flaky.txt", path: "/flaky.txt" });
    act(() => {
      store.setEntries([e]);
      store.setLastError("e1", "provider locked the file");
    });
    render(<DetailsView store={store} />);
    const pin = screen.getByTestId("explorer-error-pin");
    expect(pin.getAttribute("title")).toBe("provider locked the file");
    expect(pin.getAttribute("aria-label")).toBe("provider locked the file");
  });

  it("does NOT render an error glyph when lastError is null", () => {
    const store = makeStore();
    const e = seedEntry({ id: "e1", name: "fine.txt", path: "/fine.txt" });
    act(() => {
      store.setEntries([e]);
    });
    render(<DetailsView store={store} />);
    expect(screen.queryByTestId("explorer-error-pin")).toBeNull();
  });

  it("does NOT render an error glyph on a row whose id doesn't match lastError.entryId", () => {
    const store = makeStore();
    const a = seedEntry({ id: "e1", name: "flaky.txt", path: "/flaky.txt" });
    const b = seedEntry({ id: "e2", name: "fine.txt", path: "/fine.txt" });
    act(() => {
      store.setEntries([a, b]);
      store.setLastError("e1", "some reason");
    });
    render(<DetailsView store={store} />);
    const rows = screen.getAllByTestId("explorer-row");
    const fineRow = rows.find((r) => r.getAttribute("data-entry-id") === "e2");
    expect(within(fineRow!).queryByTestId("explorer-error-pin")).toBeNull();
  });
});

describe("DetailsPane — slide animation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    __resetExplorerStoreCacheForTests();
  });
  afterEach(() => cleanup());

  it("stays mounted when closed (so exit animation can play) and is hidden from the a11y tree", () => {
    const store = makeStore();
    // default: detailsPaneOpen = false
    const { container } = render(<DetailsPane store={store} />);
    // Pane stays in the DOM but marked closed + hidden from assistive tech.
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside!.getAttribute("data-state")).toBe("closed");
    // When closed, queryByRole must return null (matches the existing
    // Phase 5 visibility test: hidden attr or aria-hidden excludes the role).
    expect(
      screen.queryByRole("complementary", { name: /details/i }),
    ).toBeNull();
  });

  it("carries data-state='open' + motion-safe slide-in classes when open", () => {
    const store = makeStore();
    act(() => {
      store.toggleDetailsPane();
    });
    const { container } = render(<DetailsPane store={store} />);
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside!.getAttribute("data-state")).toBe("open");
    // The slide motion is whitelistable only when gated behind
    // `motion-safe:` + `data-[state=*]:` variants (see motion-budget +
    // shadcn reduced-motion tests).
    expect(aside!.className).toMatch(
      /motion-safe:data-\[state=open\]:animate-in/,
    );
    expect(aside!.className).toMatch(
      /motion-safe:data-\[state=open\]:slide-in-from-right/,
    );
    expect(aside!.className).toMatch(
      /motion-safe:data-\[state=closed\]:animate-out/,
    );
    expect(aside!.className).toMatch(
      /motion-safe:data-\[state=closed\]:slide-out-to-right/,
    );
  });
});
