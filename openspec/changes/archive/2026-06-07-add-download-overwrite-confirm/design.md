## Context

The `files:download` IPC command silently truncates any pre-existing file at `toPath` on the first cycle (`createWriteStream(toPath, { flags: "w", start: 0 })` at `services/fs-sync/src/commands/files-download.ts:1018`). The gap was surfaced during the `add-download-resilience` §11.19 manual smoke (Bug 5, 2026-05-01): the user re-downloaded a file to test the cancel button and the original was overwritten without warning. iter-4 deferred the fix to its own change because the iter-4 scope was already wide (four other bugs). This change closes Bug 5 by introducing a conflict-resolution flow for downloads that mirrors the rename precedent already shipped in `add-engine-rename-download` (archived 2026-04-29, merged commit `2762401`).

The architectural blueprint lives in `apps/desktop/src/renderer/src/features/file-explorer/store.ts` and `services/fs-sync/src/commands/files-rename.ts`:

- Renderer dispatches `files.rename` with `conflictPolicy: "fail"` (default).
- Service returns `{ tag: "conflict", existingPath }` on a collision.
- Renderer prompts the user via `rename-conflict-dialog.tsx`.
- User's choice (`"overwrite"` / `"keep-both"` / `"cancel"`) drives a re-dispatch with the chosen policy or aborts.

The download case is structurally identical — same three-option matrix, same envelope shape (with two new optional hint fields), same dialog. The only architectural choice is *where* the conflict probe runs: renderer-side pre-check (new `files:stat-local` IPC) or service-side gate (handler probes `toPath`). The service-side gate is race-free (single window of inspection + open) and reuses existing patterns; the pre-check option creates two paths to truncation and a real TOCTOU race. Decision 1 locks this in.

The capability surface touches:

- **`fs-sync-service`** — `files:download` handler gains a `conflictPolicy` field on its request shape and a probe step between `validateToPath` and the concurrency guard. The existing `flags: "w"` truncation at line 1018 is preserved; the gate gates *upstream* of it.
- **`file-explorer`** — renderer state machine on download dispatch handles the new `tag: "conflict"` envelope, prompts via the reused dialog, re-dispatches with the user's policy choice or aborts client-side.
- **`packages/ipc-contracts/src/files.ts`** — extends `FilesCommandError` with two optional fields (`existingSize?: number`, `existingModifiedAt?: string`) and `FilesDownloadRequest` with `conflictPolicy?: "fail" | "overwrite" | "keep-both"`.
- **`apps/desktop/src/renderer/src/features/file-explorer/rename-conflict-dialog.tsx`** — title and description are extracted as props (defaulting to current rename copy); hint-metadata block renders when `existingSize` / `existingModifiedAt` are populated. Component name kept as-is for minimal churn (a future cleanup change can rename to `ConflictResolutionDialog` if the dual-flow naming becomes load-bearing).

## Goals / Non-Goals

**Goals:**

- Re-downloading a file that already exists at `toPath` MUST surface a user-visible prompt with three options (overwrite / keep-both / cancel) before any bytes flow. No silent destructive overwrite.
- The existing rename-conflict dialog component is reused for the download flow with parameterized copy and optional hint metadata. One component, two callers.
- The conflict gate runs server-side (handler holds the single window where existence is checked AND truncation happens), eliminating the TOCTOU race the renderer pre-check option would introduce.
- The `keep-both` path computes the next free `name (N).ext` race-free via atomic `O_CREAT|O_EXCL` probes, matching the rename `keep-both` semantics.
- Resume-of-self detection: a paused-then-resumed download whose registry entry is still alive does NOT re-prompt the user when the partial file at `toPath` was created by the registry's own job. Forward-compatible with `migrate-download-registry-to-sqlite`.
- IPC envelope shape is additive: `existingSize` + `existingModifiedAt` on `FilesCommandError` and `conflictPolicy` on `FilesDownloadRequest` are all optional. Existing rename callers that don't populate them are unaffected.

**Non-Goals:**

- **Whole-folder overwrite confirmation.** Bulk-download flows aren't wired today (downloads are per-file). When folder downloads land, an "apply to all" affordance becomes a separate scope.
- **Native trash routing of overwritten files.** `shell.trashItem` is platform-specific and worth its own change.
- **Diff preview before overwrite.** Hashing local files is expensive on large media; the lightweight hint metadata (size + modifiedAt) covers the common "is this the same file I just downloaded?" check without the cost of a content compare.
- **Per-datasource policy defaults** (e.g., "always overwrite for Drive, always rename for S3"). Belongs in settings; deferred.
- **Hash-based byte-identical skip.** Provider hashes vary by datasource; local hashes are expensive on large files; the simpler "always prompt when destination exists" is correct in every case.
- **Concurrency-guard `toPath` extension.** The handler's existing `findByKey` keys on `(datasourceId, sourcePath)`. Two simultaneous downloads from different sources to the same `toPath` slip through that guard *and* the new conflict gate (both probes see no file, both write). Deferred to its own change — see Risks / Trade-offs.
- **Renaming the dialog component to `ConflictResolutionDialog`.** Mechanical rename worth doing once two flows share it; deferred to keep this change focused.

## Decisions

### Decision 1 — Service-side gate via shared rename `conflictPolicy` enum

**Choice:** Extend `FilesDownloadRequest` with `conflictPolicy?: "fail" | "overwrite" | "keep-both"` (default `"fail"`). The handler probes `fs.stat(toPath)` between `validateToPath` (`files-download.ts:520`–`524`) and the concurrency guard (`files-download.ts:539`–`550`). On `"fail"` policy + existing destination → return `{ ok: false, error: { tag: "conflict", existingPath, existingSize, existingModifiedAt } }`. On `"overwrite"` → proceed; the existing `flags: "w"` at line 1018 truncates the destination on the first cycle as today. On `"keep-both"` → compute the next free filename via the suffix loop (Decision 2), mutate the handler-local `effectiveTargetPath`, proceed.

**Rationale:** Rename solved this exact problem (initial dispatch with `conflictPolicy: "fail"` → service surfaces `tag: "conflict"` → renderer prompts → re-dispatch with chosen policy). Reusing the enum verbatim — same three values, same semantics — avoids minting a parallel error tag (`destination-exists`) and a parallel renderer state machine. The codebase already has two distinct conflict-policy enums (rename's `"fail" | "overwrite" | "keep-both"` per `add-engine-rename-download` Decision 7; upload's `"overwrite" | "duplicate" | "skip"`); adding a third surface that *shares the rename enum* keeps the vocabulary at two, not three.

**Alternative rejected — Renderer-side pre-check.** A new `files:stat-local` IPC lets the orchestrator probe `toPath` before dispatching `files:download`. Simpler IPC shape, but creates two destructive paths through the same code (the renderer flow can race with another renderer-initiated flow OR with a service-internal cycle), and the gap between "I checked, file didn't exist" and "I now write" is a real TOCTOU window even on a single-user desktop. The service-side gate has a single window for both inspection and write — the file either exists when the handler probes, or it doesn't, and the handler's window through to the open syscall is unbroken.

**Insertion point:** `services/fs-sync/src/commands/files-download.ts:524`–`540`. After `validateToPath` (so we never probe an unwritable path), before the concurrency guard (so the conflict envelope can be returned without registering a partial job). The destructive `flags: "w"` at line 1018 is unchanged — the gate runs upstream of the cycle loop, and the cycle loop already correctly distinguishes `flags: "w"` (first cycle) from `flags: "r+"` (resume cycles) based on `effectiveRangeStart`.

### Decision 2 — Suffix loop ownership: handler-side via `O_CREAT|O_EXCL`

**Choice:** `"keep-both"` policy → handler computes the next free `name (N).ext` filename using `fs.open(candidate, "wx")` (the Node equivalent of `O_CREAT|O_EXCL`) iteratively until a candidate succeeds. Convention: parenthesized integer starting at `(1)`, incrementing. The initial download then opens the same path with `flags: "w", start: 0` and the cycle loop proceeds against `effectiveTargetPath`.

**Rationale:** Race-free against the local FS — `O_CREAT|O_EXCL` is atomic; if a sibling process creates `name (1).ext` between our probe and our open, the open fails with `EEXIST` and we try `name (2).ext`. The renderer-side suffix-loop alternative requires either a chatty stat-per-attempt round trip or a bulk-list IPC; both lose the atomicity guarantee.

**Convention rationale:** `name (1).ext` matches the rename `keep-both` suffix the engine emits (per `add-engine-rename-download` Decision 7). The user's open question 3 asked whether timestamp-suffix (`name 2026-05-02.ext`) might be friendlier — rejected because it diverges from the rename precedent and only saves the iterative-probe cost (which is ~microseconds even at probe count of 50).

**Edge cases:**

- The empty `name (0).ext` is never produced — start at `(1)`.
- If `name.ext` has no extension, suffix becomes `name (1)` (no extension dot).
- The probe MUST start with the original filename component, NOT the toPath directory part. A directory existence at `toPath` is a different failure mode (`validateToPath` already rejects it).
- Suffix counter has no upper bound in this design, but in practice the iterative open will hit a `ENOSPC` or filename-length limit long before the user could care. The handler's existing terminal-error machinery surfaces those.

### Decision 3 — Envelope hint metadata: extend `FilesCommandError` with size + modifiedAt

**Choice:** Add two optional fields to `FilesCommandError` in `packages/ipc-contracts/src/files.ts`:

```typescript
export interface FilesCommandError {
  tag: FilesErrorTag;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  existingPath?: string;
  existingSize?: number;        // NEW — bytes, when known
  existingModifiedAt?: string;  // NEW — ISO 8601 instant, when known
}
```

The download conflict gate populates both from `fs.stat(toPath)` (`stats.size`, `stats.mtime.toISOString()`). Rename callers MAY populate them (the rename strategy already does an existence probe in some providers) but are not required to — the dialog renders the hint block only when at least one is present.

**Rationale:** The dialog needs to answer "is this the file I just downloaded?" without forcing the user to context-switch to a file manager. Size + modifiedAt is enough signal for the common cases ("oh, that's last week's copy, replace it" vs "wait, that's the in-progress one I edited, don't overwrite"). Both fields come for free — the gate has to call `fs.stat(toPath)` anyway to know whether the file exists. No extra round trip, no extra cost.

**Alternative rejected — hash-based byte-identical skip.** Provider hashes (Drive `md5Checksum`, S3 `ETag`) are advertised in metadata, but reading the local file's hash requires streaming it through a digest. For a 4 GB media file that's 10–30 seconds of pure CPU. The user is faster than the hash. Always-prompt with size+modifiedAt is the simpler, never-wrong design.

**Why optional, not required:** The same envelope shape is used by `files:rename` and other downstream handlers that may not have stat data. Making the fields optional keeps the rename callsites compatible without forcing a stat call where none is needed. The download-conflict envelope MUST populate both (enforced by the spec scenario, not the type system).

### Decision 4 — Resume-of-self carve-out

**Choice:** The conflict gate skips when `DownloadRegistry.findByKey(datasourceId, sourcePath)` returns an entry whose `targetPath === toPath` AND `bytesDownloaded > 0`. The pre-existing partial file at `toPath` belongs to the registry's own aborted download, not a foreign collision — re-dispatching `files:download` for the same `(datasourceId, sourcePath)` is a *resume*, not a conflict.

**Rationale:** Today the registry is in-memory only (per `add-engine-rename-download` design) and evaporates on app restart. So this carve-out is reachable mid-session only — the user pauses, sees the toast, clicks "Retry" or whatever resume affordance ships next. After `migrate-download-registry-to-sqlite` lands, app-restart hydration replays the registry from SQLite; restart-after-pause flows would otherwise re-prompt the user with a "destination exists" dialog the second they launched the app. That would be obnoxious. The carve-out is the right shape now and forward-compatible.

**Subtle interaction with the concurrency guard:** The existing concurrency guard at `files-download.ts:539`–`550` rejects a *second* `files:download` for the same `(datasourceId, sourcePath)` while the first is in flight (`findByKey` returns a non-undefined `id`). The carve-out doesn't change that — it triggers only when a registry entry exists AND `bytesDownloaded > 0`, which means the in-flight job has produced bytes. The concurrency guard catches the "two simultaneous identical dispatches" case; the carve-out catches the "resume of an in-flight job that's mid-cycle". Different windows, no overlap.

**Alternative rejected — always-prompt-on-existence.** Simpler, never has bugs, but defeats the resume affordance once SQLite rehydration lands. The user's mental model of "I paused this, I'm resuming this" doesn't include "you'll re-prompt me to confirm".

### Decision 5 — Dialog reuse via prop-extracted title/description on existing component

**Choice:** Extract `title` and `description` as fields on `RenameConflictDialogProps` in `apps/desktop/src/renderer/src/features/file-explorer/rename-conflict-dialog.tsx`. Default values match the current rename copy ("File already exists" / "A file at this path already exists. Choose what to do for this rename."). The download flow passes its own copy ("Download destination already exists" / "A file already exists at the download destination. Choose how to proceed.").

Render the new envelope hint metadata (`existingSize`, `existingModifiedAt`) when at least one is present — formatted size (e.g., "4.2 MB") and the modified timestamp above the existing path block. When neither is present, the hint block is omitted (rename callers continue to render path-only).

**As-shipped deviation (Phase E/F).** The "relative time (e.g., '2 minutes ago')" example above was aspirational. The renderer has no relative-time formatter, and the existing file-list "modified" column formatter this decision points to is `formatDate` from `view-modes/details-format.ts`, which renders an **absolute** en-US date ("Apr 18, 2026"). Per the design's own "no new dep" rule, the hint reuses that existing `formatDate` (paired with `formatSize` — the same pair the upload conflict-resolution-dialog uses at lines 108–110), so the hint reads e.g. "4.2 MB · modified Apr 18, 2026" rather than a relative string. No relative-time dependency was introduced.

**Rationale:** The dialog matrix is already `"overwrite" | "keep-both" | "cancel"` verbatim. The decision matrix matches; only the surrounding copy and the optional hint render differ. Extracting two props is the minimal change. A sister-component approach (separate `DownloadConflictDialog` reusing internals) would double the test surface for no behavioral gain.

**Component naming:** Keep `RenameConflictDialog` for now. The name is mildly misleading once both flows share it, but renaming touches every test file and import site for no behavioral gain. A future mechanical rename to `ConflictResolutionDialog` is a clean follow-up if the dual-flow naming becomes load-bearing.

**Default focus / keyboard behavior:** Match the current rename dialog. No autofocus on a destructive button — focus lands on the dialog container, Enter does nothing, Tab cycles through Overwrite → Keep both → Cancel. Escape and overlay-click route through Cancel. WCAG AA contrast is unchanged (amber-600 for Overwrite is already audited in the rename flow).

**Alternative considered — sister component with shared internals.** Lets the rename copy and download copy diverge over time without coupling them. Rejected: today the divergence is two strings; the duplicated test surface (same matrix, same a11y, same keyboard behavior under two component names) is more cost than the optionality buys.

## Visual direction

No new visual design. The dialog reuse path keeps the existing chrome:

- shadcn `Dialog` primitives (same as rename and upload conflict dialogs).
- Amber-themed Overwrite button (`bg-amber-600 text-white`), outline Keep-both, ghost Cancel.
- Single-column footer-button layout, full-width buttons, max-w-md container.
- Visual Companion is *not* engaged for this change — the component is reused as-is. If a future round of UX feedback wants to refresh the dialog (e.g., add a thumbnail preview, change button order, introduce a "remember my choice" checkbox), brainstorming + Visual Companion engages at that point per the visual-refinement trigger.

The new hint-metadata block is utilitarian: a small `text-muted-foreground text-xs` line above the `data-testid="rename-conflict-existing-path"` block reading e.g. "4.2 MB · modified Apr 18, 2026". Format size with the renderer's existing byte-formatting utility and the modified timestamp with the existing file-list "modified" column formatter (`formatSize` + `formatDate` from `view-modes/details-format.ts`). Both are renderer-local, no new dep. (As-shipped the timestamp is **absolute**, not the relative "2 minutes ago" the earlier draft imagined — see the **As-shipped deviation** under Decision 5.)

## Risks / Trade-offs

**Risk:** Two simultaneous downloads from different `(datasourceId, sourcePath)` pairs to the same `toPath` slip through both the concurrency guard *and* the new conflict gate. Both probe-empty, both write, second writer corrupts the first. → **Mitigation:** Document as a known gap. In practice it requires the user to start two downloads with the same target filename in the same folder *within milliseconds*, which is functionally impossible for a hand-driven UI. A future change can extend the concurrency guard to key on `toPath` as a secondary check; deferring keeps this change focused on the silent-overwrite gap actually surfaced by the smoke.

**Risk:** Suffix-loop probe count is unbounded. A pathological case (50,000 files named `name (N).ext` in the same folder) makes the loop slow. → **Mitigation:** Real-world filename collisions are dozens, not thousands. If this ever becomes a real load (it won't), a future change can switch to hash-suffix or insert a probe-budget cap with a fallback to a UUID suffix.

**Risk:** The optional `existingSize` / `existingModifiedAt` fields on `FilesCommandError` are populated only by the download conflict gate today. A future rename strategy that wants to surface them must populate them at the engine layer. → **Mitigation:** Documented as optional in the spec; existing rename callsites work unchanged. If a rename caller does populate them, the dialog renders the hint block automatically.

**Risk:** Renaming the component (`RenameConflictDialog` → `ConflictResolutionDialog`) is deferred. The name reads slightly wrong once two flows share the dialog. → **Mitigation:** Follow-up change. Mechanical rename, low risk, low priority.

**Risk:** The resume-of-self carve-out could mask a legitimate "user pasted a foreign file at exactly the registry's expected `toPath`" edge case. The handler would skip the gate and overwrite the foreign file when the resume cycle opens with `flags: "w"` (initial cycle) or `flags: "r+"` (resume cycle). → **Mitigation:** This requires the user to manually drop a file at exactly the in-flight download's target path — extraordinarily unlikely. The carve-out's correctness is bounded by registry truth: if the registry says we're resuming, we're resuming.

**Trade-off:** The conflict gate adds one `fs.stat(toPath)` syscall per download, even when no conflict exists. Negligible cost (microseconds), measured against the gate's value (no silent destructive overwrites).

**Trade-off:** Adding `conflictPolicy` to the `FilesDownloadRequest` shape is a breaking-ish change for any external caller that constructs the request literal — but the ipc-contracts package is internal, all callers are in this repo, and the field is optional with a `"fail"` default. No external API is broken.

## Migration Plan

No data migration. No deploy gating. Forward-compatible with the in-memory `DownloadRegistry` today and with `migrate-download-registry-to-sqlite` once it lands.

Rollback: revert the change set. The existing destructive-overwrite behavior returns; no on-disk state is corrupted by the rollback (the conflict gate and suffix loop are stateless against persistent storage).

## Open Questions

None. All five stub-level questions are resolved in Decisions 1–5.
