/**
 * Pre-paint motion bootstrap script.
 *
 * Injected into `<head>` via `dangerouslySetInnerHTML` on a bare `<script>`
 * tag so it runs synchronously before React mounts — prevents a flash of
 * running animations before the user's Motion Safe preference is applied on
 * cold start.
 *
 * Constraints (same as theme-script.ts):
 *  - Plain ES5-ish JS only. No TypeScript, no modules, no React, no closures
 *    over undeclared globals. Must parse/run in a raw browser context AND
 *    under jsdom where we `eval` it.
 *  - Any error is swallowed silently; the fallback (no attribute set) means
 *    custom animations run — matching the "always-on" default.
 *  - The storage key is duplicated here (not imported from motion-store.ts)
 *    because an inline <script> has no module resolution. The
 *    no-fouc-motion test guards the effective behaviour.
 *
 * State machine:
 *   localStorage["ft5.motion"] === "safe"  → setAttribute data-motion="safe"
 *   otherwise                              → removeAttribute data-motion
 */
// ES5-safe: `var`, no arrow fns, no optional chaining.
export const MOTION_BOOTSTRAP_SCRIPT = `(function(){try{var k="ft5.motion";var v=null;try{v=window.localStorage.getItem(k)}catch(_){v=null}var d=document.documentElement;if(v==="safe"){d.setAttribute("data-motion","safe")}else{d.removeAttribute("data-motion")}}catch(_){}})();`
