"use client";

//
// DatasourceCard — Phase 5.4 implements the full visual composition (provider
// icon, status badge, last-sync, quick-actions menu, usage bar). This file
// starts as the minimum viable shape so Phase 5.1's populated-state test can
// assert "one card per summary with the display name as the accessible
// heading". Phase 5.3 tests will drive the full surface.

import type { DatasourceSummary } from "@ft5/ipc-contracts";

import { Card } from "@/components/ui/card";

export interface DatasourceCardProps {
  summary: DatasourceSummary;
}

export function DatasourceCard({ summary }: DatasourceCardProps) {
  return (
    <Card
      data-testid="datasource-card"
      data-datasource-id={summary.id}
      className="gap-3 p-4"
    >
      <h3 className="text-sm font-semibold">{summary.displayName}</h3>
    </Card>
  );
}
