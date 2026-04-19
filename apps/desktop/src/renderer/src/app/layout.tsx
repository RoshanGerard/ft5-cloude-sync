import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

import "../styles/globals.css";
import { AppFooter } from "../components/app-footer";
import { AppHeader } from "../components/app-header";
import { THEME_BOOTSTRAP_SCRIPT } from "../features/theme/theme-script";
import { MOTION_BOOTSTRAP_SCRIPT } from "../features/settings/motion-script";
import { DiagnosticsShortcut } from "../features/diagnostics/diagnostics-shortcut";

export const metadata: Metadata = {
  title: "ft5-cloude-sync",
  description: "Forti5 Cloude sync desktop shell",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Geist Sans + Geist Mono via next/font (design.md Decision 9). Each
  // `.variable` exposes its corresponding CSS custom property on whatever
  // element receives the className — here, <html> — so descendants can use
  // `font-sans` / `font-mono` Tailwind utilities that resolve to
  // var(--font-geist-sans) / var(--font-geist-mono) via the @theme block in
  // globals.css. Fonts are bundled at build time (zero runtime fetch).
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <head>
        {/* Pre-paint theme bootstrap — runs synchronously before React
            mounts so the `.dark` class is already set on first paint and
            there is no FOUC on cold start. See features/theme/theme-script.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
        {/* Pre-paint motion bootstrap — applies `data-motion="safe"` on
            <html> before React mounts when the user has opted into Motion
            Safe. Absent attribute = "always-on" default (custom animations
            run regardless of OS reduce-motion). Kept as a separate script
            tag from the theme branch so a failure in one doesn't swallow
            the other. See features/settings/motion-script.ts. */}
        <script dangerouslySetInnerHTML={{ __html: MOTION_BOOTSTRAP_SCRIPT }} />
      </head>
      {/* Three-layer shell (Decision 14): persistent AppHeader + AppFooter
          around the routed <main>. `min-h-dvh flex flex-col` on <body> makes
          the <main> slot fill the remaining viewport between chrome bars;
          `flex-1 min-h-0` on <main> lets inner scroll surfaces size against
          the remaining space rather than overflowing the body.

          Note: the dashboard used to render its own <main>; the dashboard
          refactor in this decision swaps that root for a <div> so we don't
          end up with nested <main> elements (invalid HTML + a11y regression). */}
      <body className="min-h-dvh flex flex-col">
        {/* Developer keyboard shortcut — Ctrl/Cmd+Shift+D jumps to the
            /diagnostics route from anywhere. Side-effect-only component;
            returns null. Mounted at layout level so the binding is live on
            every route, not just the dashboard. See
            features/diagnostics/diagnostics-shortcut.tsx. */}
        <DiagnosticsShortcut />
        <AppHeader />
        <main className="flex-1 min-h-0">{children}</main>
        <AppFooter />
      </body>
    </html>
  );
}
