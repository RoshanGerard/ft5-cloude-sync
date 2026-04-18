/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import PingPage from "../page";

describe("renderer root page", () => {
  beforeEach(() => {
    // Stub `window.api` so the page's `useEffect` can resolve without the
    // real contextBridge-exposed preload. The page only needs `.ping()`.
    (window as unknown as { api: { ping: () => Promise<unknown> } }).api = {
      ping: vi.fn().mockResolvedValue({ ok: true, ts: 1712345678901 }),
    };
  });

  it("renders the timestamp returned by window.api.ping()", async () => {
    render(<PingPage />);
    const tsEl = await screen.findByText(/1712345678901/);
    expect(tsEl).toBeInTheDocument();
  });
});
