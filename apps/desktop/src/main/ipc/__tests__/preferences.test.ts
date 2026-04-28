// add-engine-rename-download §18.1-§18.2 — RED tests for the
// main-process handlers behind `window.api.preferences.*`.
//
// The renderer's `downloads-store` (§20) is the durable owner via
// localStorage; this surface routes through main IPC to keep the
// `window.api.*` surface uniform and to give callers outside the
// store (e.g. the §22 first-download modal) a binding that doesn't
// require importing the store. The main process holds an in-memory
// `string | null` slot — no on-disk persistence (renderer is durable).

import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetPreferencesForTesting,
  handleGetDefaultDownloadsFolder,
  handleSetDefaultDownloadsFolder,
} from "../preferences.js";

describe("preferences handlers — in-memory default-downloads-folder slot", () => {
  beforeEach(() => {
    __resetPreferencesForTesting();
  });

  it("getDefaultDownloadsFolder returns null when no folder has been set", () => {
    expect(handleGetDefaultDownloadsFolder()).toBeNull();
  });

  it("setDefaultDownloadsFolder writes the slot and getDefaultDownloadsFolder reads it back", () => {
    handleSetDefaultDownloadsFolder("/Users/alice/Downloads/ft5");
    expect(handleGetDefaultDownloadsFolder()).toBe(
      "/Users/alice/Downloads/ft5",
    );
  });

  it("setDefaultDownloadsFolder with the same folder is idempotent", () => {
    handleSetDefaultDownloadsFolder("/Users/alice/Downloads/ft5");
    handleSetDefaultDownloadsFolder("/Users/alice/Downloads/ft5");
    expect(handleGetDefaultDownloadsFolder()).toBe(
      "/Users/alice/Downloads/ft5",
    );
  });

  it("setDefaultDownloadsFolder with a new folder replaces the prior value", () => {
    handleSetDefaultDownloadsFolder("/old/path");
    handleSetDefaultDownloadsFolder("/new/path");
    expect(handleGetDefaultDownloadsFolder()).toBe("/new/path");
  });

  it("__resetPreferencesForTesting clears the slot", () => {
    handleSetDefaultDownloadsFolder("/Users/alice/Downloads/ft5");
    __resetPreferencesForTesting();
    expect(handleGetDefaultDownloadsFolder()).toBeNull();
  });
});
