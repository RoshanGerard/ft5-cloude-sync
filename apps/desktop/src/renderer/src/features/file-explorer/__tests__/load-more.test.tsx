/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { createExplorerStore } from "../store.js";
import type { ExplorerStore } from "../store.js";
import { LoadMoreRegion, humanizeFilesErrorTag } from "../load-more.js";
import { seedEntry } from "./test-utils.js";

/**
 * LoadMoreRegion — the single shared "load-more region" rendered between the
 * scrollable entries area and the status row (Visual direction V-1 + V-2).
 *
 * Region state machine (precedence order):
 *   (a) loadMoreError !== null  → page-load-failed retry row (V-2)
 *   (b) nextCursor !== null     → ghost "Load more" button (V-1)
 *   (c) otherwise               → renders nothing
 *
 * These tests drive the store DIRECTLY (applyInitialPage / loadMore via a
 * stubbed window.api), mirroring status-row.test.tsx — the composite IPC
 * mock strips nextCursor, so unit coverage of the state machine uses the
 * store API.
 */

function makeStore(id = "ds-load-more"): ExplorerStore {
  return createExplorerStore(id);
}

function seedPage(
  store: ExplorerStore,
  count: number,
  nextCursor: string | null,
): void {
  const entries = Array.from({ length: count }, (_, i) =>
    seedEntry({ id: `e-${i}`, name: `file-${i}.txt` }),
  );
  act(() => {
    store.setEntries(entries);
  });
  act(() => {
    store.applyInitialPage({
      entries: store.getSnapshot().entries,
      truncated: nextCursor !== null,
      nextCursor,
    });
  });
}

/** Install a window.api.files.list stub returning a single canned response. */
function stubListResponse(response: unknown): void {
  (
    globalThis as unknown as {
      window: { api: { files: { list: () => Promise<unknown> } } };
    }
  ).window.api = {
    files: { list: () => Promise.resolve(response) },
  };
}

async function driveLoadMoreFailure(
  store: ExplorerStore,
  envelope: { tag: string; message: string; retryable?: boolean },
): Promise<void> {
  stubListResponse({
    ok: false as const,
    error: { retryable: true, ...envelope },
  });
  await act(async () => {
    await store.loadMore();
  });
}

describe("LoadMoreRegion — state machine", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders the ghost Load-more button when nextCursor !== null", () => {
    const store = makeStore();
    seedPage(store, 500, "tokA");
    render(<LoadMoreRegion store={store} />);
    const button = screen.getByRole("button", { name: "Load more" });
    expect(button).toBeInTheDocument();
  });

  it("renders NOTHING when nextCursor === null and no error (listing exhausted)", () => {
    const store = makeStore();
    seedPage(store, 42, null);
    const { container } = render(<LoadMoreRegion store={store} />);
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't load more entries/i)).not.toBeInTheDocument();
    // The region collapses to an empty render (no stray chrome).
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the page-load-failed row when loadMoreError !== null", async () => {
    const store = makeStore();
    seedPage(store, 500, "tokA");
    await driveLoadMoreFailure(store, {
      tag: "other",
      message: "connection timed out",
    });
    render(<LoadMoreRegion store={store} />);
    // The failed row swaps in: button gone, headline present.
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Couldn't load more entries")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Retry" }),
    ).toBeInTheDocument();
  });
});

describe("LoadMoreRegion — V-1 ghost button contract", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("button is shadcn ghost variant, full-width, rounded-none, border-t, h-10", () => {
    const store = makeStore();
    seedPage(store, 500, "tokA");
    render(<LoadMoreRegion store={store} />);
    const button = screen.getByRole("button", { name: "Load more" });
    expect(button).toHaveAttribute("data-variant", "ghost");
    expect(button).toHaveClass("w-full");
    expect(button).toHaveClass("rounded-none");
    expect(button).toHaveClass("border-t");
    expect(button).toHaveClass("h-10");
  });

  it("button carries a ChevronDown glyph and the visible label 'Load more' when idle", () => {
    const store = makeStore();
    seedPage(store, 500, "tokA");
    render(<LoadMoreRegion store={store} />);
    const button = screen.getByRole("button", { name: "Load more" });
    // lucide renders an <svg>; the chevron-down adapter sets the class.
    expect(button.querySelector("svg")).toBeInTheDocument();
    expect(button).toHaveTextContent("Load more");
    // Idle: aria-busy false / absent, not disabled.
    expect(button).not.toBeDisabled();
    expect(button.getAttribute("aria-busy")).not.toBe("true");
  });

  it("clicking the button invokes store.loadMore()", () => {
    const store = makeStore();
    const loadMoreSpy = vi.spyOn(store, "loadMore").mockResolvedValue();
    seedPage(store, 500, "tokA");
    render(<LoadMoreRegion store={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(loadMoreSpy).toHaveBeenCalledTimes(1);
  });
});

describe("LoadMoreRegion — busy state (V-1 / spec line 31)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("during in-flight loadMore: aria-busy=true, disabled, chevron swapped for spinner", async () => {
    const store = makeStore();
    seedPage(store, 500, "tokA");
    // A never-resolving list keeps loadingMore=true so we can observe busy.
    (
      globalThis as unknown as {
        window: { api: { files: { list: () => Promise<unknown> } } };
      }
    ).window.api = {
      files: { list: () => new Promise(() => {}) },
    };
    render(<LoadMoreRegion store={store} />);
    act(() => {
      void store.loadMore();
    });
    const button = screen.getByRole("button", { name: "Load more" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    // Spinner present (animate-spin); chevron-down is swapped out.
    expect(button.querySelector(".animate-spin")).toBeInTheDocument();
    // Entries remain present in state (selection-preservation is the store's
    // job; here we just confirm busy doesn't blow away the count).
    expect(store.getSnapshot().entries.length).toBe(500);
  });
});

describe("LoadMoreRegion — V-2 page-load-failed row", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("row uses bg-destructive/8 tint + border-t border-destructive/20 + text-destructive", async () => {
    const store = makeStore();
    seedPage(store, 500, "tokA");
    await driveLoadMoreFailure(store, {
      tag: "other",
      message: "connection timed out",
    });
    render(<LoadMoreRegion store={store} />);
    const row = screen.getByTestId("load-more-failed");
    expect(row.className).toContain("bg-destructive/8");
    expect(row.className).toContain("border-t");
    expect(row.className).toContain("border-destructive/20");
    expect(row.className).toContain("text-destructive");
  });

  it("row announces via aria-live='assertive'", async () => {
    const store = makeStore();
    seedPage(store, 500, "tokA");
    await driveLoadMoreFailure(store, { tag: "other", message: "boom" });
    render(<LoadMoreRegion store={store} />);
    expect(screen.getByTestId("load-more-failed")).toHaveAttribute(
      "aria-live",
      "assertive",
    );
  });

  it("detail line carries the humanized wire tag + message (+ attempt phrasing)", async () => {
    const store = makeStore();
    seedPage(store, 500, "tokA");
    // A network failure exhausts fs-sync's retry and reaches the renderer as
    // the WIRE tag `disconnected` (normalizeFilesError maps engine
    // network-error -> disconnected) — NOT the engine tag `network-error`,
    // which can never cross the wire.
    await driveLoadMoreFailure(store, {
      tag: "disconnected",
      message: "connection timed out",
    });
    render(<LoadMoreRegion store={store} />);
    const row = screen.getByTestId("load-more-failed");
    expect(row).toHaveTextContent(
      /Disconnected: connection timed out after 4 attempts/i,
    );
  });

  it("renders the generic wire tag `other` as 'Error: <message>' (the production-common copy)", async () => {
    // fs-sync collapses engine errors it cannot classify (incl. a generic
    // provider-error) to wire `other`, humanized to "Error" — the message
    // carries the specifics. This is the string the product actually shows;
    // the mockup's literal "Network error" never appears because that engine
    // tag does not cross the wire.
    const store = makeStore();
    seedPage(store, 500, "tokA");
    await driveLoadMoreFailure(store, {
      tag: "other",
      message: "connection timed out",
    });
    render(<LoadMoreRegion store={store} />);
    const row = screen.getByTestId("load-more-failed");
    expect(row).toHaveTextContent(
      /Error: connection timed out after 4 attempts/i,
    );
  });

  it("Retry button is full-width outline and wired to store.retryLoadMore()", async () => {
    const store = makeStore();
    const retrySpy = vi.spyOn(store, "retryLoadMore").mockResolvedValue();
    seedPage(store, 500, "tokA");
    await driveLoadMoreFailure(store, { tag: "other", message: "boom" });
    render(<LoadMoreRegion store={store} />);
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveAttribute("data-variant", "outline");
    expect(retry).toHaveClass("w-full");
    fireEvent.click(retry);
    expect(retrySpy).toHaveBeenCalledTimes(1);
  });

  it("already-loaded entries stay in state when the failed row shows", async () => {
    const store = makeStore();
    seedPage(store, 500, "tokA");
    await driveLoadMoreFailure(store, { tag: "other", message: "boom" });
    render(<LoadMoreRegion store={store} />);
    expect(store.getSnapshot().entries.length).toBe(500);
  });

  it("does NOT steal focus when the failed row appears", async () => {
    const store = makeStore();
    seedPage(store, 500, "tokA");
    await driveLoadMoreFailure(store, { tag: "other", message: "boom" });
    // A sentinel element holds focus before the row renders.
    const sentinel = document.createElement("button");
    sentinel.textContent = "sentinel";
    document.body.appendChild(sentinel);
    sentinel.focus();
    expect(document.activeElement).toBe(sentinel);
    render(<LoadMoreRegion store={store} />);
    // Row appears; focus must remain on the sentinel (no autoFocus theft).
    expect(document.activeElement).toBe(sentinel);
    sentinel.remove();
  });
});

describe("humanizeFilesErrorTag (pure helper)", () => {
  it("maps known wire tags to friendly labels", () => {
    expect(humanizeFilesErrorTag("rate-limited")).toBe("Rate limited");
    expect(humanizeFilesErrorTag("auth-revoked")).toBe("Authorization revoked");
    expect(humanizeFilesErrorTag("disconnected")).toBe("Disconnected");
  });

  it("title-cases unknown / kebab tags (e.g. the engine 'network-error')", () => {
    expect(humanizeFilesErrorTag("network-error")).toBe("Network error");
    expect(humanizeFilesErrorTag("other")).toBe("Error");
  });
});
