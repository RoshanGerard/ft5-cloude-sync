// Task 11.1 build guardrail — OAuth client-ID/secret build-time injection.
//
// These tests enforce two invariants as code-shape assertions:
//
//   (a) `electron.vite.config.ts` declares `__FT5_GOOGLE_OAUTH_CLIENT_ID__`
//       and `__FT5_GOOGLE_OAUTH_CLIENT_SECRET__` in its `define` map so
//       electron-vite inlines the values at bundle time.
//
//   (b) `apps/desktop/src/main/index.ts` consumes those build-time constants
//       (not `process.env["FT5_GOOGLE_OAUTH_CLIENT_ID"]`) when constructing
//       the broker. This ensures the packaged binary carries the values even
//       when `process.env` is absent at runtime.
//
// The tests fail until task 11.1 modifies both files.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Resolve the two source files from the project root, not from __dirname, so
// the paths stay stable regardless of where vitest is invoked from.
const desktopRoot = path.resolve(__dirname, "../../..");
const viteConfigPath = path.resolve(desktopRoot, "electron.vite.config.ts");
const mainIndexPath = path.resolve(desktopRoot, "src/main/index.ts");

describe("OAuth build-time constants guardrail", () => {
  it("electron.vite.config.ts contains __FT5_GOOGLE_OAUTH_CLIENT_ID__ in the define map", () => {
    const source = fs.readFileSync(viteConfigPath, "utf8");
    expect(source).toContain("__FT5_GOOGLE_OAUTH_CLIENT_ID__");
  });

  it("electron.vite.config.ts contains __FT5_GOOGLE_OAUTH_CLIENT_SECRET__ in the define map", () => {
    const source = fs.readFileSync(viteConfigPath, "utf8");
    expect(source).toContain("__FT5_GOOGLE_OAUTH_CLIENT_SECRET__");
  });

  it("main/index.ts uses __FT5_GOOGLE_OAUTH_CLIENT_ID__ (build-time constant, not process.env)", () => {
    const source = fs.readFileSync(mainIndexPath, "utf8");
    expect(source).toContain("__FT5_GOOGLE_OAUTH_CLIENT_ID__");
  });

  it("main/index.ts uses __FT5_GOOGLE_OAUTH_CLIENT_SECRET__ (build-time constant, not process.env)", () => {
    const source = fs.readFileSync(mainIndexPath, "utf8");
    expect(source).toContain("__FT5_GOOGLE_OAUTH_CLIENT_SECRET__");
  });

  it("main/index.ts does NOT read FT5_GOOGLE_OAUTH_CLIENT_ID from process.env at runtime", () => {
    const source = fs.readFileSync(mainIndexPath, "utf8");
    // After task 11.1 the constant replaces the process.env read.
    expect(source).not.toMatch(/process\.env\[?["']FT5_GOOGLE_OAUTH_CLIENT_ID["']\]?/);
  });

  it("main/index.ts does NOT read FT5_GOOGLE_OAUTH_CLIENT_SECRET from process.env at runtime", () => {
    const source = fs.readFileSync(mainIndexPath, "utf8");
    expect(source).not.toMatch(/process\.env\[?["']FT5_GOOGLE_OAUTH_CLIENT_SECRET["']\]?/);
  });
});
