import { describe, expect, it } from "vitest";
import { buildMainWindowOptions } from "../window-options";

describe("buildMainWindowOptions", () => {
  it("enforces the non-negotiable Electron security defaults", () => {
    const options = buildMainWindowOptions();

    expect(options.webPreferences).toBeDefined();
    const wp = options.webPreferences!;

    expect(wp.contextIsolation).toBe(true);
    expect(wp.nodeIntegration).toBe(false);
    expect(wp.sandbox).toBe(true);
    expect(wp.webSecurity).toBe(true);
  });
});
