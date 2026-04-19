// AppFooter — Decision 14 (review-round-1). Single-line restrained footer
// with dynamic-year copyright. The year resolves at render time via
// `new Date().getFullYear()` so copyright notices don't rot.
//
// This is a server-compatible component: no hooks, no client-only APIs.
// Next.js will evaluate `new Date().getFullYear()` at request/render time,
// which in a long-lived Electron renderer means it updates if the app is
// open across the new-year boundary (on next re-render).

import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type AppFooterProps = HTMLAttributes<HTMLElement>;

export function AppFooter({ className, ...rest }: AppFooterProps) {
  const year = new Date().getFullYear();
  return (
    <footer
      className={cn(
        "flex h-9 shrink-0 items-center justify-center border-t border-border px-4",
        className,
      )}
      {...rest}
    >
      <p className="text-muted-foreground text-xs">
        © {year} Forti5 Tech. All rights reserved.
      </p>
    </footer>
  );
}
