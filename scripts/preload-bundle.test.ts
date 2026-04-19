import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// The Electron preload runs inside a sandboxed context whose require() can
// resolve ONLY the "electron" module. Any other specifier — including
// workspace packages — that survives bundling as a runtime `require(...)`
// call will fail to load at runtime with "module not found", silently
// breaking `window.api` exposure and cascading into "Cannot read properties
// of undefined" errors in the renderer.
//
// Phase 3 added runtime imports of `DATASOURCES_CHANNELS` from
// `@ft5/ipc-contracts` to the preload. `electron-vite`'s
// `externalizeDepsPlugin()` externalized that workspace dep by default,
// producing a compiled preload with `require("@ft5/ipc-contracts")` at
// line 3 that crashes the sandbox. The fix is to exclude the workspace
// package from externalization in `electron.vite.config.ts`.
//
// This test is a regression guard: it reads the compiled preload bundle
// and asserts no forbidden runtime `require(...)` calls survive. It only
// runs when `dist/preload/index.js` exists (i.e. after a build); otherwise
// it skips, so a clean-clone `pnpm -w test` without a prior Electron build
// still passes.
//
// ALLOWED runtime requires in preload: only `"electron"` (the Electron
// sandbox can resolve it). Everything else — workspace packages, third-
// party deps — MUST be bundled into the emitted CJS.

const PRELOAD_PATH = path.resolve(
  repoRoot,
  "apps/desktop/dist/preload/index.js",
);

const ALLOWED_REQUIRE_SPECIFIERS = new Set<string>(["electron"]);

const REQUIRE_CALL_RE = /require\(\s*(["'])([^"']+)\1\s*\)/g;

describe("preload bundle forbids runtime requires of workspace deps", () => {
  const fileExists = existsSync(PRELOAD_PATH);

  it.skipIf(!fileExists)(
    "compiled preload only requires allowed specifiers",
    () => {
      const source = readFileSync(PRELOAD_PATH, "utf8");
      const forbidden: string[] = [];
      let match: RegExpExecArray | null;
      REQUIRE_CALL_RE.lastIndex = 0;
      while ((match = REQUIRE_CALL_RE.exec(source)) !== null) {
        const specifier = match[2]!;
        if (!ALLOWED_REQUIRE_SPECIFIERS.has(specifier)) {
          forbidden.push(specifier);
        }
      }
      expect(
        forbidden,
        `compiled preload must not contain runtime require() calls for ` +
          `non-allowed specifiers. Found: ${forbidden.join(", ")}. ` +
          `Fix: add the specifier to externalizeDepsPlugin's exclude list ` +
          `in apps/desktop/electron.vite.config.ts so it's bundled into ` +
          `the preload output.`,
      ).toEqual([]);
    },
  );

  it("records the Electron sandbox constraint as a durable test intent", () => {
    expect(ALLOWED_REQUIRE_SPECIFIERS.has("electron")).toBe(true);
    expect(ALLOWED_REQUIRE_SPECIFIERS.size).toBe(1);
  });
});
