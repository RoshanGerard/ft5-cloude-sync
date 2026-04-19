"use client";

//
// Home route — the datasources dashboard. Replaces the original ping probe
// (now at `/diagnostics`, see `./diagnostics/page.tsx`) per the MODIFIED
// "Desktop app launches with a single main window" requirement in the
// ui-ux-design OpenSpec change.
//
// This file is intentionally thin: the composition lives in
// `features/datasources/dashboard.tsx` so the state-machine states can be
// tested in isolation without pulling in the Next.js page module.

import { DatasourcesProvider } from "@/features/datasources/store";
import { DatasourcesDashboard } from "@/features/datasources/dashboard";

export default function HomePage() {
  return (
    <DatasourcesProvider>
      <DatasourcesDashboard />
    </DatasourcesProvider>
  );
}
