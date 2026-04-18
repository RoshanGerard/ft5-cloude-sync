// Pure helpers for the navigation-deflection policy. Extracted from the
// `will-navigate` and `setWindowOpenHandler` callbacks in `index.ts` so the
// deny/openExternal decision is covered by unit tests without booting
// Electron. See `openspec/changes/setup-project/specs/app-shell/spec.md`
// Requirement 2, scenario "External navigation is deflected".
//
// The policy is intentionally identical for both `will-navigate` and
// `setWindowOpenHandler`: any non-`app:` navigation is denied; `https:` URLs
// additionally get handed to the OS browser via `shell.openExternal`.

export type NavigationDecision = { action: "deny" } | { action: "deny"; openExternal: string };

export function willNavigatePolicy(targetUrl: string): NavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { action: "deny" };
  }
  if (parsed.protocol === "app:") {
    // Internal navigation is served by the `app://` protocol handler; the
    // will-navigate hook still denies (the caller short-circuits before
    // applying the decision for `app:`), and the open-window hook always
    // denies secondary windows.
    return { action: "deny" };
  }
  if (parsed.protocol === "https:") {
    return { action: "deny", openExternal: targetUrl };
  }
  return { action: "deny" };
}

export const windowOpenPolicy = willNavigatePolicy;
