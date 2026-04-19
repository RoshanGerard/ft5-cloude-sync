"use client"

import { useSyncExternalStore } from "react"

/**
 * Motion preference store — the user-tunable toggle that controls whether
 * our custom product animations respect the OS `prefers-reduced-motion`
 * signal. Modelled on `theme-store.ts` but simpler: two values only, no
 * matchMedia listener (the OS signal is consumed directly by CSS, not by JS).
 *
 * Model:
 *   - "always-on"  → default. Custom animations (sync-pulse, sync-ripple,
 *                    skeleton-shimmer) run unconditionally. The storage key
 *                    is absent and `data-motion` is NOT set on <html>.
 *   - "safe"       → user opt-in. Writes `localStorage["ft5.motion"] = "safe"`
 *                    and sets `data-motion="safe"` on <html>. A CSS override
 *                    in globals.css (`html[data-motion="safe"]` under a
 *                    `prefers-reduced-motion: reduce` media query) then
 *                    disables the custom animations when the OS agrees.
 *
 * This deliberately deviates from the pure a11y-first stance (Decision 10)
 * because user testing revealed dev machines silently running with
 * `prefers-reduced-motion: reduce` — custom animations were being suppressed
 * without the user knowing. Motion is now "always on" by default; users who
 * want OS-respectful behaviour toggle Motion Safe on in Settings.
 *
 * shadcn primitive animations (Dialog / DropdownMenu / Tooltip) are NOT
 * affected by this store — they use Tailwind's `motion-safe:` variants and
 * remain gated at the utility level, independent of this preference.
 */

export type MotionPreference = "always-on" | "safe"

export const MOTION_STORAGE_KEY = "ft5.motion"

const listeners = new Set<() => void>()

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined"
}

function notify(): void {
  for (const l of listeners) l()
}

export function getStoredPreference(): MotionPreference {
  if (!isBrowser()) return "always-on"
  try {
    const raw = window.localStorage.getItem(MOTION_STORAGE_KEY)
    if (raw === "safe") return "safe"
    // Any other value — missing, "always-on", or garbage from a prior schema —
    // resolves to the default. We could have stored "always-on" explicitly,
    // but keeping the default key-absent is simpler and mirrors the
    // theme-store's "system" representation.
    return "always-on"
  } catch {
    return "always-on"
  }
}

export function applyEffectivePreference(): void {
  if (!isBrowser()) return
  const pref = getStoredPreference()
  const root = document.documentElement
  if (pref === "safe") {
    root.setAttribute("data-motion", "safe")
  } else {
    root.removeAttribute("data-motion")
  }
}

export function setPreference(pref: MotionPreference): void {
  if (!isBrowser()) return
  try {
    if (pref === "safe") {
      window.localStorage.setItem(MOTION_STORAGE_KEY, "safe")
    } else {
      // "always-on" is represented by the absence of the key — keeps the
      // storage schema minimal and mirrors theme-store's treatment of
      // "system".
      window.localStorage.removeItem(MOTION_STORAGE_KEY)
    }
  } catch {
    // Storage quota / sandbox — still apply the DOM change.
  }
  applyEffectivePreference()
  notify()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)

  const storageHandler = (e: StorageEvent) => {
    if (e.key === MOTION_STORAGE_KEY || e.key === null) {
      applyEffectivePreference()
      listener()
    }
  }

  if (isBrowser()) {
    window.addEventListener("storage", storageHandler)
  }

  return () => {
    listeners.delete(listener)
    if (isBrowser()) {
      window.removeEventListener("storage", storageHandler)
    }
  }
}

export function useMotionPreference(): MotionPreference {
  return useSyncExternalStore(
    subscribe,
    () => getStoredPreference(),
    () => "always-on",
  )
}
