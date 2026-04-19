import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

import "../styles/globals.css";
import { THEME_BOOTSTRAP_SCRIPT } from "../features/theme/theme-script";

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
      </head>
      <body>{children}</body>
    </html>
  );
}
