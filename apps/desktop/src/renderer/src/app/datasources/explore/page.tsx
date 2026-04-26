"use client";

//
// File-explorer route — `/datasources/explore?id=<datasourceId>`.
//
// Per design.md Decision 1 (amended in commit 336f0e8 for static-export
// compatibility), the datasource id is passed as the `id` query parameter
// rather than a dynamic `[datasourceId]` file segment. Rationale: Next.js
// `output: "export"` requires `generateStaticParams` to enumerate every
// possible segment value at build time, which breaks the moment a user adds
// a datasource at runtime via the add-flow (ids like `ds-new-1`). A single
// static page reading the id client-side sidesteps that entirely.
//
// Behaviour:
//   - No `id` → "Datasource not found" error state, no IPC dispatched.
//   - Unknown `id` (present but not returned by `window.api.datasources.list()`)
//     → same error state, rendered after the list resolves.
//   - Known `id` → <FileExplorer datasourceId={id} /> mounts and instantiates
//     the per-datasource store via `useExplorerStore(id)`.
//
// Suspense boundary: Next 16's `useSearchParams()` requires a <Suspense>
// boundary under `output: "export"`; the content subcomponent is the thing
// that calls it, while the default export just wraps in <Suspense>.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import type { DatasourceSummary } from "@ft5/ipc-contracts";

import { Button } from "@/components/ui/button";
import { DatasourcesProvider } from "@/features/datasources/store";
import { FileExplorer } from "@/features/file-explorer/file-explorer";
import type { ProviderKind } from "@/features/file-explorer/search-results";

/**
 * Collapse the contract's `providerId` (`"google-drive" | "onedrive" |
 * "amazon-s3"`) into the presentation-layer `ProviderKind`. Only the
 * known ids are mapped; unknown providers (e.g. a future addition that
 * ships before this mapping is updated) fall back to `"s3"` — the one
 * provider whose search isn't deferred, so a stale mapping never traps
 * the user behind a spurious deferred surface.
 */
function providerKindFromId(providerId: string): ProviderKind {
  switch (providerId) {
    case "google-drive":
      return "google-drive";
    case "onedrive":
      return "onedrive";
    case "amazon-s3":
      return "s3";
    default:
      return "s3";
  }
}

import type { DatasourceStatus } from "@ft5/ipc-contracts";

type ResolutionState =
  | { phase: "resolving" }
  | {
      phase: "found";
      datasourceId: string;
      providerId: string;
      providerKind: ProviderKind;
      providerStatus: DatasourceStatus;
    }
  | { phase: "not-found" };

function DatasourceNotFound() {
  return (
    <div
      data-testid="file-explorer-not-found"
      className="flex flex-col items-center justify-center gap-4 p-8 text-center"
    >
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Datasource not found</h2>
        <p className="text-muted-foreground text-sm">
          The datasource you&apos;re trying to explore couldn&apos;t be located. It may have been removed.
        </p>
      </div>
      <Button asChild size="sm">
        <Link href="/">Return to dashboard</Link>
      </Button>
    </div>
  );
}

function ExplorePageContent() {
  const searchParams = useSearchParams();
  const idParam = searchParams?.get("id") ?? null;
  const hasId = idParam !== null && idParam !== "";

  // Initial phase: if `id` is absent/empty we can decide synchronously. If
  // present, we kick off the datasources list IPC and resolve against it.
  const [state, setState] = useState<ResolutionState>(
    hasId ? { phase: "resolving" } : { phase: "not-found" },
  );

  useEffect(() => {
    if (!hasId || idParam === null) return;
    let cancelled = false;

    void window.api.datasources
      .list()
      .then((response: { datasources: DatasourceSummary[] }) => {
        if (cancelled) return;
        const match = response.datasources.find((d) => d.id === idParam);
        setState(
          match
            ? {
                phase: "found",
                datasourceId: idParam,
                providerId: match.providerId,
                providerKind: providerKindFromId(match.providerId),
                providerStatus: match.status,
              }
            : { phase: "not-found" },
        );
      })
      .catch(() => {
        if (cancelled) return;
        // Treat a failing list as "not found" for now — the user still gets a
        // path back to the dashboard. A future phase can differentiate
        // transient IPC errors from truly-missing datasources.
        setState({ phase: "not-found" });
      });

    return () => {
      cancelled = true;
    };
  }, [hasId, idParam]);

  if (state.phase === "not-found") {
    return <DatasourceNotFound />;
  }
  if (state.phase === "resolving") {
    // While the list IPC is in flight we render nothing visible — the route
    // layout keeps the header/footer mounted, and subsequent chrome tasks
    // can replace this with a skeleton if the measured time feels long.
    return <div data-testid="file-explorer-resolving" aria-hidden="true" />;
  }
  // <DatasourcesProvider> is required here because the explorer's
  // invalid-datasource branch reaches into `useDatasourceActions` (for the
  // shared confirm-remove dialog) and `<InvalidDatasourceState>` reaches
  // into `useConsentSession`. The dashboard route at `app/page.tsx` already
  // wraps in the same provider; the explore route was missing it because
  // §7's component had not been wired in yet.
  // `onDatasourceRemoved` flips the route to `not-found` after the user
  // confirms Remove from the explorer's invalid-datasource arm. Without
  // this, the underlying datasource id is gone but the explorer keeps
  // re-fetching `files:list`, which the engine answers with another
  // `invalid-datasource` envelope — infinite loop into the same Pattern-A
  // state. `not-found` renders `<DatasourceNotFound>` with a "Return to
  // dashboard" link, satisfying the file-explorer spec scenario "On
  // successful Remove ... the file-explorer route SHALL navigate back to /".
  return (
    <DatasourcesProvider>
      <FileExplorer
        datasourceId={state.datasourceId}
        providerId={state.providerId}
        providerKind={state.providerKind}
        providerStatus={state.providerStatus}
        onDatasourceRemoved={() => setState({ phase: "not-found" })}
      />
    </DatasourcesProvider>
  );
}

export default function ExplorePage() {
  // Next 16 requires a <Suspense> boundary around any component that calls
  // `useSearchParams()` under `output: "export"`, otherwise the static build
  // errors out. The fallback is `null` — the outer layout chrome (header +
  // footer) stays mounted during the brief suspense window.
  return (
    <Suspense fallback={null}>
      <ExplorePageContent />
    </Suspense>
  );
}
