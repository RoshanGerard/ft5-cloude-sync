import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

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
  return (
    <html lang="en">
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
