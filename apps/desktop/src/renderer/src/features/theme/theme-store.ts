"use client"

import { useSyncExternalStore } from "react"

/**
 * Single source of truth for the renderer's theme preference.
 *
 * Stored in `localStorage` under `ft5.theme`. The "system" preference is
 * represented by the *absence* of the key so a cold-start inline script
 * (see `theme-script.ts`) can evaluate it without having to parse a string
 * sentinel — any truthy value is a user override.
 *
 * Consumers either call the pure functions (`getEffectiveTheme`,
 * `setPreference`, etc.) or subscribe via the React hook `usePreference()`
 * built on `useSyncExternalStore`, which is the React 18/19 idiom for
 * browser-global state like localStorage + matchMedia.
 */

export type ThemePreference = "light" | "dark" | "system"

export const THEME_STORAGE_KEY = "ft5.theme"

const DARK_QUERY = "(prefers-color-scheme: dark)"

const listeners = new Set<() => void>()

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined"
}

function notify(): void {
  for (const l of listeners) l()
}

export function getStoredPreference(): ThemePreference {
  if (!isBrowser()) return "system"
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (raw === "light" || raw === "dark") return raw
    return "system"
  } catch {
    return "system"
  }
}

export function getEffectiveTheme(): "light" | "dark" {
  const pref = getStoredPreference()
  if (pref === "light" || pref === "dark") return pref
  if (!isBrowser()) return "light"
  try {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light"
  } catch {
    return "light"
  }
}

export function applyEffectiveTheme(): void {
  if (!isBrowser()) return
  const effective = getEffectiveTheme()
  const root = document.documentElement
  if (effective === "dark") root.classList.add("dark")
  else root.classList.remove("dark")
}

export function setPreference(pref: ThemePreference): void {
  if (!isBrowser()) return
  try {
    if (pref === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY)
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, pref)
    }
  } catch {
    // Swallow — storage quota / sandbox. We still apply the DOM change.
  }
  applyEffectiveTheme()
  notify()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)

  let mql: MediaQueryList | undefined
  const mqlHandler = () => {
    // OS preference changed — re-apply only if the user is on "system".
    if (getStoredPreference() === "system") applyEffectiveTheme()
    listener()
  }

  if (isBrowser()) {
    try {
      mql = window.matchMedia(DARK_QUERY)
      mql.addEventListener("change", mqlHandler)
    } catch {
      mql = undefined
    }
  }

  const storageHandler = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY || e.key === null) {
      applyEffectiveTheme()
      listener()
    }
  }

  if (isBrowser()) {
    window.addEventListener("storage", storageHandler)
  }

  return () => {
    listeners.delete(listener)
    if (mql) {
      try {
        mql.removeEventListener("change", mqlHandler)
      } catch {
        // best-effort
      }
    }
    if (isBrowser()) {
      window.removeEventListener("storage", storageHandler)
    }
  }
}

export function usePreference(): ThemePreference {
  return useSyncExternalStore(
    subscribe,
    () => getStoredPreference(),
    () => "system",
  )
}
