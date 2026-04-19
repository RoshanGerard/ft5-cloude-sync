"use client";

//
// DatasourcesDashboard (tasks 5.1, 5.2, 5.5) — composes the state-machine
// rendering for the home view: loading / empty / populated / error. The
// toolbar (Add Datasource button + ThemeSwitcher) lives in its own component
// so it can be tested independently and re-used if we ever split the page.

import { useCallback, useRef, useState, type MouseEvent, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

import { ThemeSwitcher } from "@/features/theme/theme-switcher";

import { AddDatasourceDialog } from "./add-dialog";
import { DatasourceCard } from "./card";
import { EmptyDatasourcesIllustration } from "./illustrations/empty-datasources";
import { useDatasourceActions, useDatasources } from "./store";

export function DatasourcesToolbar({
  onAddDatasourceClick,
  triggerRef,
}: {
  onAddDatasourceClick: (event: MouseEvent<HTMLElement>) => void;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border p-4">
      <h1 className="text-base font-semibold">Datasources</h1>
      <div className="flex items-center gap-2">
        <Button
          ref={triggerRef}
          size="sm"
          onClick={onAddDatasourceClick}
          data-testid="add-datasource-trigger"
        >
          Add datasource
        </Button>
        <ThemeSwitcher />
      </div>
    </div>
  );
}

export function DashboardStates({
  onAddDatasourceClick,
}: {
  onAddDatasourceClick: (event: MouseEvent<HTMLElement>) => void;
}) {
  const state = useDatasources();
  const actions = useDatasourceActions();

  if (state.phase === "loading") {
    return <DashboardLoading />;
  }
  if (state.phase === "empty") {
    return <DashboardEmpty onAddDatasourceClick={onAddDatasourceClick} />;
  }
  if (state.phase === "error") {
    return (
      <DashboardError
        message={state.error}
        onRetry={() => {
          void actions.refresh();
        }}
      />
    );
  }
  return <DashboardPopulated datasources={state.datasources} />;
}

function DashboardLoading() {
  // Three generic shimmer placeholders. The shimmer class must be
  // `animate-skeleton-shimmer` so the motion-budget guardrail passes and the
  // dashboard loading test asserts at least one visible shimmer element.
  return (
    <div
      data-testid="datasources-loading"
      className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {Array.from({ length: 3 }).map((_, idx) => (
        <Card key={idx} className="p-4">
          <Skeleton className="animate-skeleton-shimmer h-5 w-1/2" />
          <Skeleton className="animate-skeleton-shimmer mt-3 h-4 w-2/3" />
          <Skeleton className="animate-skeleton-shimmer mt-3 h-4 w-1/3" />
        </Card>
      ))}
    </div>
  );
}

function DashboardEmpty({
  onAddDatasourceClick,
}: {
  onAddDatasourceClick: (event: MouseEvent<HTMLElement>) => void;
}) {
  return (
    <div
      data-testid="datasources-empty"
      className="flex flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <EmptyDatasourcesIllustration className="h-40 w-60 text-muted-foreground" />
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">No cloud datasources yet</h2>
        <p className="text-muted-foreground text-sm">
          Connect Google Drive, OneDrive, or Amazon S3 to start syncing files.
        </p>
      </div>
      <Button
        size="sm"
        onClick={onAddDatasourceClick}
        data-testid="empty-add-datasource-trigger"
      >
        Add datasource
      </Button>
    </div>
  );
}

function DashboardError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid="datasources-error"
      role="alert"
      className="flex flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h2 className="text-lg font-semibold">Couldn&apos;t load datasources</h2>
      <p className="text-muted-foreground text-sm">{message}</p>
      <Button size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function DashboardPopulated({
  datasources,
}: {
  datasources: import("@ft5/ipc-contracts").DatasourceSummary[];
}) {
  return (
    <div
      data-testid="datasources-grid"
      className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {datasources.map((ds) => (
        <DatasourceCard key={ds.id} summary={ds} />
      ))}
    </div>
  );
}

export function DatasourcesDashboard() {
  // Phase 6.3: lift dialog-open state here so both the toolbar trigger and
  // the empty-state CTA open the same dialog.
  //
  // Focus restoration: we remember which HTMLElement fired the click (the
  // toolbar trigger or the empty-state CTA) and hand it to
  // `AddDatasourceDialog` via `returnFocusTo`. The dialog uses Radix's
  // `onCloseAutoFocus` (with `preventDefault`) to redirect focus there —
  // Radix's default restoration relies on the element being focused at
  // open time, which is unreliable in jsdom where `fireEvent.click` does
  // not implicitly focus the button. The toolbar-trigger fallback handles
  // the case where the empty-state CTA unmounts after the add succeeds.
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const toolbarTriggerRef = useRef<HTMLButtonElement | null>(null);

  const onAddDatasourceClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      openerRef.current = event.currentTarget;
      setAddDialogOpen(true);
    },
    [],
  );

  const returnFocusTo =
    openerRef.current && openerRef.current.isConnected
      ? openerRef.current
      : toolbarTriggerRef.current;

  return (
    <main className="flex min-h-dvh flex-col">
      <DatasourcesToolbar
        onAddDatasourceClick={onAddDatasourceClick}
        triggerRef={toolbarTriggerRef}
      />
      <DashboardStates onAddDatasourceClick={onAddDatasourceClick} />
      <AddDatasourceDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        returnFocusTo={returnFocusTo}
      />
    </main>
  );
}
