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
    document.documentElement.removeAttribute("data-theme");
    // Default to a light system preference. Individual tests override as needed.
    vi.stubGlobal("matchMedia", stubMatchMedia(false));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders a trigger with an accessible name", () => {
    render(<ThemeSwitcher />);
    const trigger = screen.getByRole("button", { name: /toggle theme/i });
    expect(trigger).toBeInTheDocument();
  });

  it("opens a menu containing exactly Light, Dark, Serene Blue, System in order on click", async () => {
    render(<ThemeSwitcher />);
    const trigger = screen.getByRole("button", { name: /toggle theme/i });
    fireEvent.pointerDown(trigger, { button: 0 });

    const items = await screen.findAllByRole("menuitem");
    // Review-round-3, Task 6: Serene Blue slots in between Dark and System.
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent(/light/i);
    expect(items[1]).toHaveTextContent(/^dark$/i);
    expect(items[2]).toHaveTextContent(/serene blue/i);
    expect(items[3]).toHaveTextContent(/system/i);
  });

  it("opens the menu via keyboard (Enter on trigger)", async () => {
    render(<ThemeSwitcher />);
    const trigger = screen.getByRole("button", { name: /toggle theme/i });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });

    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(4);
  });

  it("selecting Dark applies `.dark`, removes data-theme, and writes localStorage", async () => {
    // Simulate stale serene-blue attribute from a previous session — selecting
    // Dark must strip it (review-round-3, Task 6: `applyEffectiveTheme`
    // manages both channels on every call).
    document.documentElement.setAttribute("data-theme", "serene-blue");

    render(<ThemeSwitcher />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /toggle theme/i }), { button: 0 });
    const darkItem = await screen.findByRole("menuitem", { name: /^dark$/i });
    fireEvent.click(darkItem);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("selecting Light removes `.dark` and data-theme and writes localStorage", async () => {
    document.documentElement.classList.add("dark");
    document.documentElement.setAttribute("data-theme", "serene-blue");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(<ThemeSwitcher />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /toggle theme/i }), { button: 0 });
    const lightItem = await screen.findByRole("menuitem", { name: /light/i });
    fireEvent.click(lightItem);

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("selecting Serene Blue sets data-theme, removes `.dark`, and writes localStorage", async () => {
    document.documentElement.classList.add("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(<ThemeSwitcher />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /toggle theme/i }), { button: 0 });
    const sereneItem = await screen.findByRole("menuitem", { name: /serene blue/i });
    fireEvent.click(sereneItem);

    expect(document.documentElement.getAttribute("data-theme")).toBe("serene-blue");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("serene-blue");
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
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("selecting System removes the localStorage key and does NOT apply `.dark` when OS prefers light", async () => {
    vi.stubGlobal("matchMedia", stubMatchMedia(false));
    document.documentElement.classList.add("dark");
    document.documentElement.setAttribute("data-theme", "serene-blue");
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(<ThemeSwitcher />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /toggle theme/i }), { button: 0 });
    const systemItem = await screen.findByRole("menuitem", { name: /system/i });
    fireEvent.click(systemItem);

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
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
    const { unmount: unmountDark } = render(<ThemeSwitcher />);
    const darkTrigger = screen.getByRole("button", { name: /toggle theme/i });
    const darkIndicator = within(darkTrigger).getByTestId("theme-indicator");
    const darkName = darkIndicator.getAttribute("data-icon");
    unmountDark();

    // Serene Blue (review-round-3, Task 6)
    localStorage.setItem(THEME_STORAGE_KEY, "serene-blue");
    render(<ThemeSwitcher />);
    const sereneTrigger = screen.getByRole("button", { name: /toggle theme/i });
    const sereneIndicator = within(sereneTrigger).getByTestId("theme-indicator");
    const sereneName = sereneIndicator.getAttribute("data-icon");

    // Four distinct indicators — one per preference state.
    const names = [systemName, lightName, darkName, sereneName];
    expect(new Set(names).size).toBe(4);
    expect(names.every(Boolean)).toBe(true);
  });

  it("propagates theme changes to a mounted Toaster (shared store)", async () => {
    render(
      <>
        <ThemeSwitcher />
        <Toaster />
      </>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: /toggle theme/i }), { button: 0 });
    const darkItem = await screen.findByRole("menuitem", { name: /^dark$/i });
    fireEvent.click(darkItem);

    const toaster = screen.getByTestId("sonner-stub");
    expect(toaster).toHaveAttribute("data-theme", "dark");
  });

  it("maps Serene Blue to 'light' when forwarding to Sonner (sonner's theme union is light|dark|system)", async () => {
    render(
      <>
        <ThemeSwitcher />
        <Toaster />
      </>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: /toggle theme/i }), { button: 0 });
    const sereneItem = await screen.findByRole("menuitem", { name: /serene blue/i });
    fireEvent.click(sereneItem);

    // Sonner doesn't know about "serene-blue"; our wrapper translates the
    // preference to "light" so Sonner's theme switch is well-defined. The
    // actual toast chrome colours still resolve through the CSS custom
    // properties (--popover, --border, etc.) which the `[data-theme=...]`
    // selector overrides — so toasts on Serene Blue still pick up the
    // correct palette without Sonner needing to know about it.
    const toaster = screen.getByTestId("sonner-stub");
    expect(toaster).toHaveAttribute("data-theme", "light");
  });
});
