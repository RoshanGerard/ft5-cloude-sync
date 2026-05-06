// In-memory `UploadRegistry` for the fs-sync service. Holds the
// UPLOAD-side state: a `Map<uploadJobId, UploadJobEntry>` of in-flight
// uploads. Exposed via the `uploads:list-active` RPC (§10.1) and consumed
// by the `files:upload` handler (§9).
//
// See:
// - openspec/changes/migrate-upload-orchestration-out-of-engine/design.md
//   "Decision 6 — `UploadRegistry` mirrors `DownloadRegistry` exactly"
//   and "Decision 10 — Concurrent-upload conflict is a hard, pre-engine
//   guard" (the reverse-index keys on `(datasourceId, targetPath)`, not
//   `(datasourceId, sourcePath)` — the **target** slot is the conflict
//   key).
// - openspec/changes/migrate-upload-orchestration-out-of-engine/specs/
//   fs-sync-service/spec.md "Requirement: `UploadRegistry` tracks
//   in-flight uploads in memory".
//
// Naming note. The IPC-exposed `UploadJob` from `@ft5/ipc-contracts`
// (sync-service/commands.ts) is the wire shape — `uploadJobId`,
// `datasourceId`, `sourcePath`, `targetPath`, `bytesUploaded`,
// `contentLength`, `startedAt`, no `abortController`. This service-internal
// shape carries the `AbortController` so the handler can drive cancels
// through it; we name it `UploadJobEntry` to avoid a collision when the
// §10 list-active handler imports both types and projects between them.
// Mirror of `DownloadRegistry`'s `DownloadJobEntry` naming convention.
//
// Concurrency. JavaScript is single-threaded, so map mutations are atomic
// at the call boundary. The "concurrent updates do not lose data" property
// just means this API does not read-modify-write across awaits in a way
// that races. All methods are synchronous; `update` uses spread-replace
// (fresh object per call) so a snapshot taken before an update is
// unaffected by the update.

/**
 * One in-flight upload tracked by the service. Identity fields
 * (`uploadJobId`, `datasourceId`, `sourcePath`, `targetPath`, `startedAt`)
 * and the `abortController` are immutable for the entry's lifetime — only
 * `bytesUploaded` and `contentLength` mutate as the engine streams
 * bytes. The `update` API enforces this at the type level via
 * `UploadJobUpdate`.
 *
 * Mirrors the IPC-exposed `UploadJob` from `@ft5/ipc-contracts`
 * (sync-service/commands.ts) plus an `abortController` field. Field
 * `readonly` markers match the IPC type so projecting one to the other in
 * §10.1 is a structural drop-the-controller.
 */
export interface UploadJobEntry {
  readonly uploadJobId: string;
  readonly datasourceId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly bytesUploaded: number;
  readonly contentLength: number | null;
  readonly startedAt: number; // ms epoch
  readonly abortController: AbortController;
}

/**
 * Partial accepted by `UploadRegistry.update` — narrows to the two
 * fields the engine's streaming bytes legitimately mutate. Identity
 * fields and the abort controller are unrepresentable in this type so
 * the compiler rejects an attempt to reassign them.
 */
export type UploadJobUpdate = Partial<
  Pick<UploadJobEntry, "bytesUploaded" | "contentLength">
>;

export interface UploadRegistry {
  /**
   * Adds an entry keyed by `entry.uploadJobId`. If an entry with the same
   * id already exists, it is replaced (last-writer-wins). The handler
   * mints a fresh `uploadJobId` per `files:upload` invocation so a
   * collision indicates a programming error upstream — we tolerate it
   * silently rather than throw, to keep the registry contract as
   * forgiving as `Map.set`.
   */
  set(entry: UploadJobEntry): void;

  /**
   * Returns the live entry, or `undefined` if no entry with that
   * `uploadJobId` exists. The returned object is the one stored in the
   * registry; callers must not mutate it. (`update` replaces the slot
   * with a fresh object, so mutating a returned reference does NOT
   * propagate to subsequent gets / snapshots — but it would tear
   * concurrent readers, so don't.)
   */
  get(uploadJobId: string): UploadJobEntry | undefined;

  /**
   * Merges `partial` into the existing entry. No-op (and no throw) if
   * `uploadJobId` is unknown — this matches the handler's reality: an
   * `onProgress` callback for a job whose registry entry was already
   * removed by a terminal event is a benign race we want to swallow.
   *
   * Implementation uses `set(id, { ...prev, ...partial })` so a snapshot
   * taken before the update keeps its pre-update values.
   */
  update(uploadJobId: string, partial: UploadJobUpdate): void;

  /**
   * Removes the entry. No-op (and no throw) if `uploadJobId` is
   * unknown — see `update` rationale.
   */
  delete(uploadJobId: string): void;

  /**
   * Returns a stable copy of the current entries ordered by `startedAt`
   * ascending (oldest first). The returned array is fresh per call;
   * mutating it (push, splice, etc.) does not mutate the registry.
   * Entry references are shared with the registry, but entries are
   * `readonly` and `update` replaces (not mutates) the slot, so
   * snapshot consumers see a consistent point-in-time view.
   *
   * Used by the `uploads:list-active` handler (§10.1) to project to the
   * IPC-exposed `UploadJob[]` shape (drops `abortController`).
   */
  snapshot(): UploadJobEntry[];

  /**
   * Reverse-index lookup (per Decision 10 + spec.md "Concurrent-target
   * upload conflict guard"). Returns the `uploadJobId` for the in-flight
   * `(datasourceId, targetPath)` pair, or `undefined` if no entry exists
   * for that target slot. O(1) — backed by a Map keyed on
   * `${datasourceId}::${targetPath}` updated in lockstep with `set` /
   * `delete`.
   *
   * Identity fields (`datasourceId`, `targetPath`) are immutable across
   * an entry's lifetime per the §8 design, so the reverse-index does
   * NOT track `update` mutations — only insertions and removals.
   *
   * Used by the `files:upload` handler's concurrent-target rejection
   * guard (rejects a second upload to an in-flight `(datasourceId,
   * targetPath)` BEFORE any engine call is issued, per spec.md
   * "Concurrent-target upload conflict guard").
   *
   * Decision 6 — keys on the **target** slot only, not source. Two
   * different local files racing for the same remote target is a
   * conflict regardless of which source is the second writer.
   */
  findByTarget(datasourceId: string, targetPath: string): string | undefined;

  /** Number of entries currently in the registry. */
  size(): number;
}

export function createUploadRegistry(): UploadRegistry {
  const entries = new Map<string, UploadJobEntry>();
  // Reverse index keyed `${datasourceId}::${targetPath}` → uploadJobId.
  // Updated in lockstep with `set` / `delete`. NOT touched by `update`
  // because identity fields are immutable per the entry contract.
  const byTarget = new Map<string, string>();
  const keyOf = (datasourceId: string, targetPath: string): string =>
    `${datasourceId}::${targetPath}`;

  function set(entry: UploadJobEntry): void {
    // If the slot is being replaced (last-writer-wins) AND the prior entry
    // had a different `(datasourceId, targetPath)`, drop the old reverse
    // mapping. In practice this never fires because the handler mints a
    // fresh `uploadJobId` per call; the defensive sweep just keeps the
    // index honest if a caller violates the contract.
    const prev = entries.get(entry.uploadJobId);
    if (prev !== undefined) {
      const prevKey = keyOf(prev.datasourceId, prev.targetPath);
      if (byTarget.get(prevKey) === entry.uploadJobId) {
        byTarget.delete(prevKey);
      }
    }
    entries.set(entry.uploadJobId, entry);
    byTarget.set(
      keyOf(entry.datasourceId, entry.targetPath),
      entry.uploadJobId,
    );
  }

  function get(uploadJobId: string): UploadJobEntry | undefined {
    return entries.get(uploadJobId);
  }

  function update(uploadJobId: string, partial: UploadJobUpdate): void {
    const prev = entries.get(uploadJobId);
    if (prev === undefined) return;
    // Replace, don't mutate — keeps snapshot stability and avoids any
    // shared-reference tear with concurrent readers. The abortController
    // is carried by reference (do NOT clone — the handler aborts cancels
    // through this exact instance). Identity fields are typed-locked out
    // of `UploadJobUpdate` so the reverse-index never needs touching.
    entries.set(uploadJobId, { ...prev, ...partial });
  }

  function deleteEntry(uploadJobId: string): void {
    const prev = entries.get(uploadJobId);
    if (prev === undefined) return;
    entries.delete(uploadJobId);
    const prevKey = keyOf(prev.datasourceId, prev.targetPath);
    // Defensive: only delete the reverse mapping if it still points at
    // this id (a `set` for a fresh job on the same target may have
    // already overwritten it).
    if (byTarget.get(prevKey) === uploadJobId) {
      byTarget.delete(prevKey);
    }
  }

  function snapshot(): UploadJobEntry[] {
    return Array.from(entries.values()).sort(
      (a, b) => a.startedAt - b.startedAt,
    );
  }

  function findByTarget(
    datasourceId: string,
    targetPath: string,
  ): string | undefined {
    return byTarget.get(keyOf(datasourceId, targetPath));
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
    findByTarget,
    size,
  };
}
