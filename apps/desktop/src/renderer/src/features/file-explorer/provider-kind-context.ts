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
 * Default is `"s3"` (engine-backed) so that the disable-Rename/
 * Download guarantee fails *closed* — any consumer that forgets
 * to wrap FileContextMenu in a provider gets the safe treatment.
 * Stand-alone tests for synthetic mock affordances MUST explicitly
 * wrap in `<ProviderKindContext.Provider value="mock">`.
 */
export const ProviderKindContext = createContext<ProviderKind>("s3");

export function useProviderKind(): ProviderKind {
  return useContext(ProviderKindContext);
}
