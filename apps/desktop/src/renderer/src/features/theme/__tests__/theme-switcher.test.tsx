/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Mock the `sonner` package BEFORE `@/components/ui/sonner` is imported, so the
// Toaster prop capture works for the "shared store" propagation test below.
// `data-sonner-toaster` only renders on the <ol> once a toast is queued and
// `data-sonner-theme` (not `data-theme`) carries the theme — so inspecting the
// prop directly is both simpler and more faithful to task 4.6a's "light-touch"
// assertion.
vi.mock("sonner", async () => {
  const React = await import("react");
  return {
    Toaster: (props: { theme?: string }) =>
      React.createElement("div", {
        "data-testid": "sonner-stub",
        "data-theme": props.theme ?? "",
      }),
  };
});

import { ThemeSwitcher } from "../theme-switcher";
import { Toaster } from "@/components/ui/sonner";

const THEME_STORAGE_KEY = "ft5.theme";

type MatchMediaStub = (matches: boolean) => ReturnType<typeof vi.fn>;

const stubMatchMedia: MatchMediaStub = (matches) =>
  vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    // Default to a light system preference. Individual tests override as needed.
    vi.stubGlobal("matchMedia", stubMatchMedia(false));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("renders a trigger with an accessible name", () => {
    render(<ThemeSwitcher />);
    const trigger = screen.getByRole("button", { name: /toggle theme/i });
    expect(trigger).toBeInTheDocument();
  });

  it("opens a menu containing exactly Light, Dark, System in order on click", async () => {
    render(<ThemeSwitcher />);
    const trigger = screen.getByRole("button", { name: /toggle theme/i });
    fireEvent.pointerDown(trigger, { button: 0 });

    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(/light/i);
    expect(items[1]).toHaveTextContent(/dark/i);
    expect(items[2]).toHaveTextContent(/system/i);
  });

  it("opens the menu via keyboard (Enter on trigger)", async () => {
    render(<ThemeSwitcher />);
    const trigger = screen.getByRole("button", { name: /toggle theme/i });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });

    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(3);
  });

  it("selecting Dark applies `.dark` and writes localStorage", async () => {
    render(<ThemeSwitcher />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /toggle theme/i }), { button: 0 });
    const darkItem = await screen.findByRole("menuitem", { name: /dark/i });
    fireEvent.click(darkItem);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("selecting Light removes `.dark` and writes localStorage", async () => {
    document.documentElement.classList.add("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(<ThemeSwitcher />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /toggle theme/i }), { button: 0 });
    const lightItem = await screen.findByRole("menuitem", { name: /light/i });
    fireEvent.click(lightItem);

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("selecting System removes the localStorage key and applies `.dark` when OS prefers dark", async () => {
    vi.stubGlobal("matchMedia", stubMatchMedia(true));
    localStorage.setItem(THEME_STORAGE_KEY, "light");

    render(<ThemeSwitcher />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /toggle theme/i }), { button: 0 });
    const systemItem = await screen.findByRole("menuitem", { name: /system/i });
    fireEvent.click(systemItem);

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("selecting System removes the localStorage key and does NOT apply `.dark` when OS prefers light", async () => {
    vi.stubGlobal("matchMedia", stubMatchMedia(false));
    document.documentElement.classList.add("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(<ThemeSwitcher />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /toggle theme/i }), { button: 0 });
    const systemItem = await screen.findByRole("menuitem", { name: /system/i });
    fireEvent.click(systemItem);

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("reflects the current effective theme in its trigger (indicator differs per state)", () => {
    // System (default — no storage key, matchMedia light)
    const { unmount: unmountSystem } = render(<ThemeSwitcher />);
    const systemTrigger = screen.getByRole("button", { name: /toggle theme/i });
    const systemIndicator = within(systemTrigger).getByTestId("theme-indicator");
    const systemName = systemIndicator.getAttribute("data-icon");
    unmountSystem();

    // Light
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { unmount: unmountLight } = render(<ThemeSwitcher />);
    const lightTrigger = screen.getByRole("button", { name: /toggle theme/i });
    const lightIndicator = within(lightTrigger).getByTestId("theme-indicator");
    const lightName = lightIndicator.getAttribute("data-icon");
    unmountLight();

    // Dark
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeSwitcher />);
    const darkTrigger = screen.getByRole("button", { name: /toggle theme/i });
    const darkIndicator = within(darkTrigger).getByTestId("theme-indicator");
    const darkName = darkIndicator.getAttribute("data-icon");

    // Three distinct indicators — one per preference state.
    expect(new Set([systemName, lightName, darkName]).size).toBe(3);
    expect([systemName, lightName, darkName].every(Boolean)).toBe(true);
  });

  it("propagates theme changes to a mounted Toaster (shared store)", async () => {
    render(
      <>
        <ThemeSwitcher />
        <Toaster />
      </>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: /toggle theme/i }), { button: 0 });
    const darkItem = await screen.findByRole("menuitem", { name: /dark/i });
    fireEvent.click(darkItem);

    const toaster = screen.getByTestId("sonner-stub");
    expect(toaster).toHaveAttribute("data-theme", "dark");
  });
});
