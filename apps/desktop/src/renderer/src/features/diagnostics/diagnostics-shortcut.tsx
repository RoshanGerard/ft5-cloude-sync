"use client";

//
// DiagnosticsShortcut (task 7.3) — a side-effect-only component that binds a
// window-level keydown listener on mount and unbinds on unmount. On
// Ctrl+Shift+D (Windows/Linux) or Cmd+Shift+D (macOS), it navigates to
// `/diagnostics` via Next.js App Router and calls `preventDefault()` so the
// browser's bookmark-all-tabs default doesn't also fire inside Electron.
//
// Mounted from `app/layout.tsx` alongside the other pre-paint scripts so the
// shortcut is available on every route.
//
// Returns null — the component produces no DOM of its own.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function DiagnosticsShortcut(): null {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Lowercase the key so browsers/platforms that deliver `"D"` and those
      // that deliver `"d"` with Shift held both match. (Firefox/Linux
      // occasionally differs from Chrome/macOS.)
      if (event.key.toLowerCase() !== "d") return;
      if (!event.shiftKey) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      // Ctrl/Cmd + Shift + D is the browser default for "Bookmark all
      // tabs" in Firefox and Chrome. We don't want that dialog flashing
      // up inside Electron, so preventDefault unconditionally before the
      // navigation push.
      event.preventDefault();
      router.push("/diagnostics");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [router]);

  return null;
}
