"use client";

import { createContext, useContext } from "react";

import type { ProviderKind } from "./search-results";

/**
 * Threads the current datasource's ProviderKind to deep consumers
 * (FileContextMenu, toolbar affordances) without re-plumbing it
 * through every view-mode component. Provided by `FileExplorer`;
 * consumed anywhere the renderer needs to know whether the
 * datasource is engine-backed (see
 * wire-file-explorer-to-service spec § Rename and Download
 * affordances are disabled for engine-backed datasources).
 *
 * Default is `"mock"` so stand-alone unit tests that mount view
 * modes without wrapping them in FileExplorer retain the enabled-
 * affordance behaviour (mock datasources pass through).
 */
export const ProviderKindContext = createContext<ProviderKind>("mock");

export function useProviderKind(): ProviderKind {
  return useContext(ProviderKindContext);
}
