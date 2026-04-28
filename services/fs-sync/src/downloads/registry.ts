// In-memory `DownloadRegistry` for the fs-sync service. Holds the
// DOWNLOAD-side state: a `Map<downloadJobId, DownloadJobEntry>` of in-flight
// downloads. Exposed via the `downloads:list-active` RPC (§14) and consumed
// by the `files:download` handler (§13).
//
// See:
// - openspec/changes/add-engine-rename-download/design.md "Decision 4"
//   (in-memory only, lives in the service handler not the engine; service
//   crashes orphan partial files — disk persistence is follow-up
//   `migrate-download-registry-to-sqlite`).
// - openspec/changes/add-engine-rename-download/specs/fs-sync-service/spec.md
//   "Requirement: In-memory `DownloadRegistry` tracks active downloads".
//
// Naming note. The IPC-exposed `DownloadJob` from `@ft5/ipc-contracts`
// (sync-service/commands.ts) is the wire shape — `downloadJobId`,
// `datasourceId`, `sourcePath`, `targetPath`, `bytesDownloaded`,
// `contentLength`, `startedAt`, no `abortController`. This service-internal
// shape carries the `AbortController` so the handler can drive cancels
// through it; we name it `DownloadJobEntry` to avoid a collision when the
// §14 list-active handler imports both types and projects between them.
//
// Concurrency. JavaScript is single-threaded, so map mutations are atomic
// at the call boundary. The "concurrent updates do not lose data" property
// just means this API does not read-modify-write across awaits in a way
// that races. All methods are synchronous; `update` uses spread-replace
// (fresh object per call) so a snapshot taken before an update is
// unaffected by the update.

/**
 * One in-flight download tracked by the service. Identity fields
 * (`downloadJobId`, `datasourceId`, `sourcePath`, `targetPath`, `startedAt`)
 * and the `abortController` are immutable for the entry's lifetime — only
 * `bytesDownloaded` and `contentLength` mutate as the engine streams
 * bytes. The `update` API enforces this at the type level via
 * `DownloadJobUpdate`.
 *
 * Mirrors the IPC-exposed `DownloadJob` from `@ft5/ipc-contracts`
 * (sync-service/commands.ts) plus an `abortController` field. Field
 * `readonly` markers match the IPC type so projecting one to the other in
 * §14 is a structural drop-the-controller.
 */
export interface DownloadJobEntry {
  readonly downloadJobId: string;
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly bytesDownloaded: number;
  readonly contentLength: number | null;
  readonly startedAt: number; // ms epoch
  readonly abortController: AbortController;
}

/**
 * Partial accepted by `DownloadRegistry.update` — narrows to the two
 * fields the engine's streaming bytes legitimately mutate. Identity
 * fields and the abort controller are unrepresentable in this type so
 * the compiler rejects an attempt to reassign them.
 */
export type DownloadJobUpdate = Partial<
  Pick<DownloadJobEntry, "bytesDownloaded" | "contentLength">
>;

export interface DownloadRegistry {
  /**
   * Adds an entry keyed by `entry.downloadJobId`. If an entry with the same
   * id already exists, it is replaced (last-writer-wins). The handler
   * mints a fresh `downloadJobId` per `files:download` invocation so a
   * collision indicates a programming error upstream — we tolerate it
   * silently rather than throw, to keep the registry contract as
   * forgiving as `Map.set`.
   */
  set(entry: DownloadJobEntry): void;

  /**
   * Returns the live entry, or `undefined` if no entry with that
   * `downloadJobId` exists. The returned object is the one stored in the
   * registry; callers must not mutate it. (`update` replaces the slot
   * with a fresh object, so mutating a returned reference does NOT
   * propagate to subsequent gets / snapshots — but it would tear
   * concurrent readers, so don't.)
   */
  get(downloadJobId: string): DownloadJobEntry | undefined;

  /**
   * Merges `partial` into the existing entry. No-op (and no throw) if
   * `downloadJobId` is unknown — this matches the engine-bus
   * subscription's reality: a `downloading` event for a job whose
   * registry entry was already removed by a terminal event is a benign
   * race we want to swallow.
   *
   * Implementation uses `set(id, { ...prev, ...partial })` so a snapshot
   * taken before the update keeps its pre-update values.
   */
  update(downloadJobId: string, partial: DownloadJobUpdate): void;

  /**
   * Removes the entry. No-op (and no throw) if `downloadJobId` is
   * unknown — see `update` rationale.
   */
  delete(downloadJobId: string): void;

  /**
   * Returns a stable copy of the current entries ordered by `startedAt`
   * ascending (oldest first). The returned array is fresh per call;
   * mutating it (push, splice, etc.) does not mutate the registry.
   * Entry references are shared with the registry, but entries are
   * `readonly` and `update` replaces (not mutates) the slot, so
   * snapshot consumers see a consistent point-in-time view.
   *
   * Used by the `downloads:list-active` handler (§14) to project to the
   * IPC-exposed `DownloadJob[]` shape (drops `abortController`).
   */
  snapshot(): DownloadJobEntry[];

  /**
   * Reverse-index lookup (per add-engine-rename-download §13.23). Returns
   * the `downloadJobId` for the in-flight `(datasourceId, sourcePath)`
   * pair, or `undefined` if no entry exists for that key. O(1) — backed
   * by a Map keyed on `${datasourceId}::${sourcePath}` updated in lockstep
   * with `set` / `delete`.
   *
   * Identity fields (`datasourceId`, `sourcePath`) are immutable across an
   * entry's lifetime per the §11 design, so the reverse-index does not
   * track `update` mutations — only insertions and removals.
   *
   * Used by:
   * - The `files:download` handler's concurrent-rejection guard (rejects
   *   a second download for the same `(datasourceId, sourcePath)` BEFORE
   *   any engine call is issued, per spec.md scenario "Concurrent
   *   download for the same `(datasourceId, path)` is rejected").
   * - The handler's engine-bus subscription callback to correlate
   *   engine `(datasourceId, path)` events back to the in-flight job's
   *   `downloadJobId` (per spec.md "Service subscribes to engine bus
   *   events for download lifecycle").
   */
  findByKey(datasourceId: string, sourcePath: string): string | undefined;

  /** Number of entries currently in the registry. */
  size(): number;
}

export function createDownloadRegistry(): DownloadRegistry {
  const entries = new Map<string, DownloadJobEntry>();
  // Reverse index keyed `${datasourceId}::${sourcePath}` → downloadJobId.
  // Updated in lockstep with `set` / `delete`. NOT touched by `update`
  // because identity fields are immutable per the entry contract.
  const byKey = new Map<string, string>();
  const keyOf = (datasourceId: string, sourcePath: string): string =>
    `${datasourceId}::${sourcePath}`;

  function set(entry: DownloadJobEntry): void {
    // If the slot is being replaced (last-writer-wins) AND the prior entry
    // had a different `(datasourceId, sourcePath)`, drop the old reverse
    // mapping. In practice this never fires because the handler mints a
    // fresh `downloadJobId` per call; the defensive sweep just keeps the
    // index honest if a caller violates the contract.
    const prev = entries.get(entry.downloadJobId);
    if (prev !== undefined) {
      const prevKey = keyOf(prev.datasourceId, prev.sourcePath);
      if (byKey.get(prevKey) === entry.downloadJobId) {
        byKey.delete(prevKey);
      }
    }
    entries.set(entry.downloadJobId, entry);
    byKey.set(keyOf(entry.datasourceId, entry.sourcePath), entry.downloadJobId);
  }

  function get(downloadJobId: string): DownloadJobEntry | undefined {
    return entries.get(downloadJobId);
  }

  function update(downloadJobId: string, partial: DownloadJobUpdate): void {
    const prev = entries.get(downloadJobId);
    if (prev === undefined) return;
    // Replace, don't mutate — keeps snapshot stability and avoids any
    // shared-reference tear with concurrent readers. The abortController
    // is carried by reference (do NOT clone — the handler aborts cancels
    // through this exact instance). Identity fields are typed-locked out
    // of `DownloadJobUpdate` so the reverse-index never needs touching.
    entries.set(downloadJobId, { ...prev, ...partial });
  }

  function deleteEntry(downloadJobId: string): void {
    const prev = entries.get(downloadJobId);
    if (prev === undefined) return;
    entries.delete(downloadJobId);
    const prevKey = keyOf(prev.datasourceId, prev.sourcePath);
    // Defensive: only delete the reverse mapping if it still points at
    // this id (a `set` for a fresh job on the same key may have already
    // overwritten it).
    if (byKey.get(prevKey) === downloadJobId) {
      byKey.delete(prevKey);
    }
  }

  function snapshot(): DownloadJobEntry[] {
    return Array.from(entries.values()).sort(
      (a, b) => a.startedAt - b.startedAt,
    );
  }

  function findByKey(
    datasourceId: string,
    sourcePath: string,
  ): string | undefined {
    return byKey.get(keyOf(datasourceId, sourcePath));
  }

  function size(): number {
    return entries.size;
  }

  return {
    set,
    get,
    update,
    delete: deleteEntry,
    snapshot,
    findByKey,
    size,
  };
}
