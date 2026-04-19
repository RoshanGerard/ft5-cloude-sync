"use client";

//
// Diagnostics route — the original ping probe relocated from `/` to
// `/diagnostics` per the MODIFIED "Desktop app launches with a single main
// window" requirement in the ui-ux-design OpenSpec change. Task 5.5 moves
// the probe here so the home route can be the datasources dashboard without
// regressing the ping IPC wiring verification (Playwright e2e in
// `apps/desktop/e2e/ping.spec.ts`). Task 7.3 will add the Ctrl/Cmd+Shift+D
// shortcut that navigates here from anywhere in the app.

import { useEffect, useState } from "react";

export default function DiagnosticsPage() {
  const [ts, setTs] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.ping().then((response) => {
      if (!cancelled) {
        setTs(response.ts);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Rendered inside `app/layout.tsx`'s outer `<main>` landmark (see Decision
  // 14 for the chrome structure). Using a plain `<div>` here avoids a nested
  // `<main>` landmark and the associated a11y regression — the layout's
  // `<main>` is the document's only main landmark.
  return <div>{ts == null ? "Pinging…" : String(ts)}</div>;
}
