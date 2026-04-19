import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The `app://` custom protocol must be registered with privileged flags
// BEFORE `app.whenReady()` resolves, otherwise Electron treats it as a
// non-standard, non-secure origin. Consequences we've already hit:
//   - `localStorage` / `sessionStorage` throw SecurityError on access,
//     silently breaking any feature that persists state in them (the
//     theme switcher is the immediate example).
//   - "Unsafe attempt to load URL app://index.html from frame with URL
//     app://index.html" console warnings on every navigation.
//   - ServiceWorker / cache / fetch APIs are unavailable.
//
// The correct call is `protocol.registerSchemesAsPrivileged([{ scheme: "app",
// privileges: { standard: true, secure: true, supportFetchAPI: true,
// corsEnabled: true } }])` at module top-level, before `bootstrap()` is
// invoked. This test reads `main/index.ts` as text and asserts the call
// is present with the correct shape. A source-scan is sufficient here
// because launching Electron from Vitest to verify runtime behavior is
// slow and brittle; the call's presence is load-bearing and verifiable
// textually.

const MAIN_INDEX = path.resolve(__dirname, "../index.ts");

describe("app:// scheme is registered with privileged flags", () => {
  const source = readFileSync(MAIN_INDEX, "utf8");

  it("calls protocol.registerSchemesAsPrivileged", () => {
    expect(
      /\bregisterSchemesAsPrivileged\s*\(/.test(source),
      "main/index.ts must call `protocol.registerSchemesAsPrivileged([...])` " +
        "before `app.whenReady()` so the `app://` scheme gets localStorage, " +
        "fetch, cors, and secure-context privileges. See " +
        "https://www.electronjs.org/docs/latest/api/protocol#protocolregisterschemesasprivilegedcustomschemes",
    ).toBe(true);
  });

  it("registers the `app` scheme with the load-bearing privileges", () => {
    // The call must include scheme: "app" AND the four privilege flags.
    // Allow whitespace/formatting flexibility but require all four.
    const hasScheme = /scheme\s*:\s*["']app["']/.test(source);
    const hasStandard = /standard\s*:\s*true/.test(source);
    const hasSecure = /secure\s*:\s*true/.test(source);
    const hasFetch = /supportFetchAPI\s*:\s*true/.test(source);
    const hasCors = /corsEnabled\s*:\s*true/.test(source);
    const missing = [
      !hasScheme && "scheme: \"app\"",
      !hasStandard && "standard: true",
      !hasSecure && "secure: true",
      !hasFetch && "supportFetchAPI: true",
      !hasCors && "corsEnabled: true",
    ].filter(Boolean);
    expect(
      missing,
      `registerSchemesAsPrivileged call is missing required flags: ${missing.join(", ")}. ` +
        `Without all of these, Electron denies localStorage and emits ` +
        `"Unsafe attempt to load URL" warnings on every navigation.`,
    ).toEqual([]);
  });

  it("registers the scheme BEFORE app.whenReady() is awaited", () => {
    // Source-order check: the registerSchemesAsPrivileged call must appear
    // before the `await app.whenReady()` line. Electron enforces this at
    // runtime — registering after whenReady is a no-op.
    const privIdx = source.search(/\bregisterSchemesAsPrivileged\s*\(/);
    // Match the awaited call site specifically — `await app.whenReady()` —
    // so the check doesn't false-positive on comment prose that mentions
    // `app.whenReady()` without actually calling it.
    const readyIdx = source.search(/\bawait\s+app\.whenReady\s*\(/);
    expect(privIdx).toBeGreaterThanOrEqual(0);
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(
      privIdx < readyIdx,
      `registerSchemesAsPrivileged must appear before app.whenReady() in ` +
        `main/index.ts. Found privIdx=${privIdx}, readyIdx=${readyIdx}.`,
    ).toBe(true);
  });
});
