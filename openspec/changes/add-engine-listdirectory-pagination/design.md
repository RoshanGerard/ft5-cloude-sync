# Design: `add-engine-listdirectory-pagination`

## Context

The `fs-datasource-engine` exposes `listDirectory(target): Promise<DatasourceFileEntry<T>[]>`
on `DatasourceClient<T>`. Three concrete strategies implement the
primitive `doListDirectoryImpl`:

| Provider | Today | Cap | Continuation token |
|----------|-------|-----|---------------------|
| **Google Drive** | one call, `pageSize: 1000`, ignores response token | 1000 entries | `nextPageToken: string` |
| **OneDrive** | one call, default Graph paging, ignores response token | ~200 entries | `@odata.nextLink: string` (absolute URL) |
| **Amazon S3** | `do/while` over `IsTruncated`/`NextContinuationToken` — auto-loops every page | none (full enumeration) | `NextContinuationToken: string` |

The wire-level `FilesListValue.truncated: boolean` field exists in
`@ft5/ipc-contracts` but is hard-coded to `false` in
`services/fs-sync/src/commands/files-list.ts:43` (and likewise in
`files-search.ts`). The renderer's status-row only branches on
`search.truncated`, never `list.truncated`. Net effect: Drive folders
of >1000 items and OneDrive folders of >200 items silently truncate
with zero UI signal; S3 always returns the full list at the cost of
IPC payload size and first-paint latency on large buckets.

Stakeholders: power users with large cloud folders (the immediate
defect surface); engine maintainers (signature change cascades through
strategies + tests); fs-sync maintainers (auto-retry policy must align
with `migrate-engine-retry-policy-to-consumer`); UX (the new
"Load more" affordance + page-size setting).

## Goals / Non-Goals

**Goals:**

- True cursor pagination — engine returns one provider page per call
  plus an opaque `nextCursor` continuation token. Consumers ask for
  the next page on demand.
- Per-provider context isolation: each strategy owns its
  native-token plumbing inside its own `doListDirectoryImpl`. The
  base class and the engine port carry the cursor as an opaque
  `string | null` and never inspect it.
- User-controllable page size, default **500**, choices
  100 / 500 / 1000 / 5000 / 10000, surfaced via Settings.
- Inline "Load more" UI affordance + status-row count update + a
  failure-and-retry row that survives across all six file-explorer
  view modes.
- fs-sync layer auto-retries page failures on a fixed schedule
  (initial + 3 attempts, 2s / 5s / 7s back-offs) before surfacing a
  manual retry to the user.
- Establish `docs/design_limitations.md` as a project-level home for
  vendor-quirk notes that don't rise to a spec requirement.

**Non-Goals:**

- Infinite-scroll auto-loading. Manual click is v1; auto-load can
  land later if usability testing shows it is wanted.
- Search-result pagination. `files:search` is a separate concern
  tracked by `add-engine-native-search`. The cursor surface designed
  here is reusable when search pagination lands.
- Cursor persistence across navigation away and back. Cursors are
  per-list-call and discarded when the explorer's path changes.
- Cross-process cursor decay / TTL. Cursors are stateless; the engine
  forwards them to the provider unchanged.
- Renaming `truncated: boolean` off the wire. It stays as a derived
  signal (`truncated === nextCursor !== null`) to avoid a second
  contract churn; a future cleanup change can remove it.

## Decisions

### Decision 1 — Architecture: true cursor pagination (Option A)

Engine port becomes
`listDirectory(target, options?): Promise<{ entries, nextCursor }>`.
The renderer holds the cursor and asks for the next page on click.

Considered alternatives:
- **B — eager full-list (S3-style for everyone).** Strategy auto-loops
  internally; engine returns flat list. Rejected: ~10k-entry Drive
  folders blow IPC payload size, slow first paint, no incremental
  rendering, no abort path mid-fetch.
- **C — streaming via bus.** First page sync + subsequent pages as
  events. Rejected: bus has no read-op streaming precedent in this
  codebase; race surface around terminal/streaming flag.
- **D — service-side virtualization.** sync-service holds cursor,
  renderer sends `(offset, limit)`. Rejected: net-new server state
  with TTL/eviction; doesn't fit current "service is a thin proxy"
  pattern.

User confirmed A on 2026-05-05.

### Decision 2 — Cursor shape: opaque `string | null`

Each strategy owns native-token plumbing inside its own
`doListDirectoryImpl`. The engine port carries
`cursor?: string` (request) and `nextCursor: string | null` (response)
as opaque values; no engine-side inspection or normalization.

Rationale: the three providers have three incompatible token shapes —
Drive's `nextPageToken` is a small base64-ish string; OneDrive's
`@odata.nextLink` is a *fully-qualified URL*; S3's
`NextContinuationToken` is a base64 blob. A structured cursor would
need a tag-and-payload shape, gaining nothing over an opaque string
since no caller introspects.

OneDrive guard: re-issuing `@odata.nextLink` requires a 5-line
`startsWith` check before passing the URL to the Graph SDK, to defend
against an upstream cursor injection. Lives in `OneDriveClient.doListDirectoryImpl`,
not in the base.

### Decision 3 — Page size: default 500, user-configurable via Settings

The engine port accepts `pageSize?: number`. Strategies clamp to
provider min/max:

- Drive: clamp to `[1, 1000]` (Drive's hard ceiling).
- OneDrive: clamp to `[1, 999]` (Graph `$top` ceiling).
- S3: clamp to `[1, 1000]` (`MaxKeys` ceiling).

When omitted, the strategy uses its prior provider default (1000 / 200 / 1000).

Renderer reads the user preference from a new localStorage key
`ft5.explorer.pageSize` (mirroring the existing `ft5.downloads.*`
pattern) on every list call. Default at first read: **500**.

Choices in the dropdown: **100, 500, 1000, 5000, 10000**. Values
above the provider-cap (5000, 10000) over-resolve to two-or-three
pages on Drive/S3 — the strategy still issues one provider call per
engine call; the renderer's "Load more" handles the rest.

Rationale for 500: balances first-paint latency (200ms-ish on a
median Drive folder) against click-fatigue. 100 felt too small for
typical cloud folders; 1000 felt slow on first paint when most
folders are <500.

### Decision 4 — Auto-retry: initial + 3 attempts at 2s / 5s / 7s

`fs-sync`'s `files:list` handler wraps `client.listDirectory` with a
fixed-schedule retry on `network-error` / `rate-limited` /
`provider-error` failures THAT ARE `retryable === true`. Total of
**4 attempts** (initial + 3 retries), back-offs **2s, 5s, 7s** between
them, ~14s wall-time budget. A non-retryable error (`retryable: false`)
surfaces immediately — notably OneDrive's deterministic malformed-cursor
guard (§3.3) throws `provider-error { retryable: false }` before any
network call, so the loop MUST NOT burn its budget on it (reconciled
2026-06-07 from the engine-slice code review).

The user's spec — "automatic 3 attempts 2sec 5sec, 7sec" — is
interpreted as three *retry waits* after the initial attempt,
producing four total attempts. Confirm or adjust during human review;
the count is a single constant.

Other tags are NOT retried by the 4-attempt env-retry loop:
- `auth-expired` — handled by the inner `withAuthRefresh` wrap (per
  `migrate-engine-retry-policy-to-consumer`, merged 2026-06-07): the
  handler refreshes once via `client.refreshCredentials()` and retries
  the call once, inside the env-retry's attempt. The engine no longer
  auto-refreshes. A still-`auth-expired` outcome after one refresh is
  terminal (not in the env-retry set) → renderer surfaces reconnect.
- `auth-revoked` — terminal; renderer surfaces reconnect.
- `cancelled` — terminal; renderer surfaces nothing.
- `invalid-datasource` — terminal; renderer surfaces invalid-state.
- `unsupported` — terminal; impossible for `listDirectory` but caught
  for safety.

After exhaustion, the response envelope is `{ ok: false, error }`
just like a single-attempt failure today. The renderer's
page-load-failed row carries the cursor on which the failure
happened — clicking Retry re-issues the same cursor; the auto-retry
budget resets per click.

### Decision 5 — Sort/search: honor vendor-native semantics

- **Drive** uses `orderBy: "folder,name"` server-side (current
  behavior). User-driven re-sort resets to page 1 with the new
  `orderBy`; pages 2..N already loaded are discarded.
- **OneDrive** uses `$orderby` server-side. Same reset-on-resort.
- **S3** has no native sort. Sort is client-side over already-loaded
  pages. Re-sorting after page 2 sorts only what's loaded; loading
  page 3 appends in provider order. This non-uniformity is a known
  limitation of the S3 surface.

Search pagination is out of scope; v1 search continues to return
one provider page (capped) and the existing `search.truncated`
status-row indicator stays.

These vendor-quirk asymmetries are recorded in
`docs/design_limitations.md`, not in the spec, since they describe
provider behavior rather than first-party requirements.

### Decision 6 — `truncated` field disposition

`FilesListValue.truncated` and `FilesSearchValue.truncated` stay on
the wire. `truncated` becomes derived (`nextCursor !== null`) on the
list path. The field's comment is reversed (`truncated` no longer
"replaces" `nextCursor`).

Rationale: removing `truncated` would force a second contract
revision in the renderer and break tests that assert on the field.
Keeping it derived means existing test fixtures continue to type-check;
a follow-up cleanup can remove it once the renderer no longer reads it.

### Decision 7 — `docs/design_limitations.md` as a new project-level doc

`docs/` does not exist today. The change establishes
`docs/design_limitations.md` as the home for vendor-quirk notes that
aren't first-party requirements. Initial entries:

1. S3 has no native `orderBy`; sort is client-side over loaded pages.
2. Drive/OneDrive support `orderBy` / `$orderby` server-side; re-sort
   discards loaded pages.
3. OneDrive's `@odata.nextLink` is a fully-qualified URL, not a
   token; the strategy validates the prefix before re-issue.
4. Page-size choices above provider caps (5000, 10000) over-resolve
   to multiple engine calls per "page" from the renderer's
   perspective.
5. Auto-retry policy (4 attempts / 14s) is a fs-sync-side decision
   layered as the OUTER ring around fs-sync's `withAuthRefresh` auth
   refresh (per `migrate-engine-retry-policy-to-consumer` — the engine
   no longer auto-refreshes; auth refresh is the one-shot inner ring).

This doc is referenced (but not normatively constrained) by the
modified `fs-datasource-engine` spec.

### Decision 8 — No new error tag for cursor invalidation

Cursor-invalidation failures reuse the EXISTING tag vocabulary — no
new tag is added. Two sub-cases: (a) a provider rejects a stale cursor
(Drive `400 Bad Request` on a malformed `pageToken`; S3
`InvalidArgument` on a malformed `ContinuationToken`) — the strategy's
`normalizeError` maps it to an engine `DatasourceError` (typically
`tag: "provider-error"`); (b) OneDrive's client-side prefix guard (§3.3)
throws `DatasourceError { tag: "provider-error" }` directly, with no
network call.

NOTE (reconciled 2026-06-07 during apply): the original draft said the
strategy surfaces `tag: "other"`, but `"other"` is NOT a member of the
engine's `DatasourceErrorTag` (the 10 engine tags live in
`packages/ipc-contracts/src/fs-datasource-engine.ts`; `"other"` is a
WIRE-level `FilesErrorTag`). The engine throws `provider-error`, and
fs-sync's `normalizeFilesError` (`files-error-mapping.ts`) collapses
every non-special engine tag — including `provider-error` — to the wire
`tag: "other"`. The renderer-observable outcome is exactly what this
decision intends.

The renderer's page-load-failed row treats it identically to any other
list failure — Retry re-issues from the SAME stale cursor (which
will fail again), and the user's recourse is to navigate away and
back, which discards the cursor.

Considered: introducing `tag: "expired-cursor"`. Rejected: the
practical impact is one extra provider round-trip on the rare-and-
already-degenerate "I left the explorer open for two days" path. The
tag-explosion cost outweighs the UX gain.

This avoids coupling pagination to
`migrate-error-tag-literals-to-const-refs`.

## Visual direction

Resolved in the 2026-05-05 `superpowers:brainstorming` Visual
Companion session. Mockups archived under
`.superpowers/brainstorm/2462-1777928142/content/`. All four
decisions below are locked in the file-explorer spec delta scenarios.

### V-1 · Load-more affordance — full-width ghost button in a dedicated zone

The affordance lives in its OWN region between the scrollable
entries area and the status row — never inside the entries scroll
container, never overlapping file content, always visible at the
bottom regardless of scroll position. Same component renders below
all six view modes (List, Details, Small/Medium/Large Icons, Tiles)
at full width.

**Locked component contract:**

```tsx
<Button
  variant="ghost"
  className="w-full justify-center gap-2 rounded-none border-t border-border h-10 font-medium"
  aria-busy={isBusy}
  disabled={isBusy}
>
  <ChevronDown className="size-4" />
  {isBusy ? <Spinner className="size-4" /> : null}
  Load more
</Button>
```

The shadcn ghost variant resolves to `bg-transparent` with
`hover:bg-accent hover:text-accent-foreground` (and
`dark:hover:bg-accent/50` in dark theme), so the bar's hover state
adapts across the three themes (light, dark, serene-blue) without
any custom palette.

### V-2 · Page-load-failed retry row — two-line layout in the same zone

When fs-sync's 4-attempt auto-retry exhausts on a "Load more" click,
the ghost button is swapped in-place for a two-line failure row at
~h-20. Layout: `bg-destructive/8` tint, `border-t border-destructive/20`,
AlertCircle icon at top-left, bold "Couldn't load more entries"
headline, smaller detail line carrying the underlying provider message
and attempt count, and a full-width outline Retry button below.
Already-loaded entries stay visible. `aria-live="assertive"`. No
focus theft from the entries area.

```
┌─────────────────────────────────────────┐
│ ⓘ  Couldn't load more entries           │ ← bold (text-destructive)
│    Network error: connection timed      │ ← detail (text-xs, opacity-85)
│    out after 4 attempts                 │
│ ┌─────────────────────────────────────┐ │
│ │           Retry                     │ │ ← full-width outline button
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### V-3 · Status row copy — three-state count

Mirrors the existing `<count> items · <suffix>` pattern from
`status-row.tsx` L96/103/105.

| State | Copy |
|-------|------|
| `nextCursor !== null` (more pages available) | `500+ items · 500 loaded` |
| Most recent Load-more failed (post-auto-retry) | `500 items · couldn't load more` |
| `nextCursor === null` (everything loaded) | `500 items` (existing behavior — no suffix) |

The selection-count suffix (`· 3 selected`) still appends when a
selection exists. Digits remain in `tabular-nums`. `aria-live="polite"`
on the row stays as-is.

### V-4 · Settings — Explorer section sits between Motion and Downloads

Section placement: between the existing Motion section and the
existing Downloads section (top-down: General → Browsing →
File-handling). Section uses the same `<h3>` + flex-row pattern as
Downloads' "Default folder" row.

**Row layout:**
- Left: label `Items loaded per page` (text-xs font-medium) +
  description `Larger values fetch more per click; smaller values
  paint faster on first load.` (text-muted-foreground text-xs)
- Right: `<Button variant="outline" size="sm">` showing the current
  value with a trailing `<ChevronDown className="size-3" />`,
  triggering a `<DropdownMenu>` with `<DropdownMenuRadioGroup>`
  carrying the five options.

```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <Button variant="outline" size="sm" aria-label="Items loaded per page">
      <span className="tabular-nums">{value.toLocaleString()}</span>
      <ChevronDown className="size-3" />
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuLabel className="text-muted-foreground text-xs uppercase tracking-wider">
      Page size
    </DropdownMenuLabel>
    <DropdownMenuRadioGroup value={String(value)} onValueChange={onChange}>
      <DropdownMenuRadioItem value="100">100</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="500">500</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="1000">1,000</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="5000">5,000</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="10000">10,000</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  </DropdownMenuContent>
</DropdownMenu>
```

This mirrors the toolbar's View-mode menu pattern (see
`apps/desktop/src/renderer/src/features/file-explorer/toolbar.tsx`)
since the codebase does not include a shadcn `Select` primitive.
Values ≥ 1000 render with comma separators. Digits use
`tabular-nums`.

## Risks / Trade-offs

**[Migrate-chain ordering]** → Blocking prereq resolved (merged
2026-06-07); the two soft prereqs were assessed non-blocking. Per-prereq
status:
- `migrate-engine-retry-policy-to-consumer` (RESOLVED — merged
  2026-06-07, master `d26f26d`): retry ownership moved to fs-sync.
  `files-list.ts` is already `withAuthRefresh`-wrapped; pagination's
  4-attempt env-retry composes as the OUTER ring around that inner
  auth wrap. `runReadOp` (base-client.ts) was unchanged by the
  migration — still error-normalization + `rate-limited` /
  `status-changed` emission, no refresh — so task 1.2's "preserve
  `runReadOp` wrap unchanged" still holds.
- `migrate-engine-events-to-consumer` (soft-blocking): listDirectory
  emits no events today. If the migration introduces a `directory-listed`
  event (or similar), pagination should follow suit on first-page-only
  emission semantics.
- `migrate-engine-cache-invalidation` (soft-blocking): Drive's
  path-cache is invalidated on `deleted` / `file-created`. Each
  page contributes path entries to the cache; if cache ownership
  moves, pagination's cache-write call site moves too.
- `migrate-error-tag-literals-to-const-refs` (informational only,
  per Decision 8): pagination introduces no new tags.

**[Cursor staleness across long-lived sessions]** → Documented in
`docs/design_limitations.md`; manual recovery is "navigate away and
back". Considered TTL'ed cursor tracking server-side (Option D from
Decision 1's alternatives) — rejected as over-engineering.

**[OneDrive `@odata.nextLink` is a URL, not a token]** → Mitigated by
strategy-side `startsWith("https://graph.microsoft.com/v1.0/")`
validation before re-issue. Documented in
`docs/design_limitations.md`.

**[Renderer state shape change]** → The explorer store's
`FilesListValue` shape gains `nextCursor`. Existing fixture data
that omits the field is added by default-spread; tests explicitly
asserting on `entries.length` continue to pass without
modification.

**[Page-size 5000/10000 vs provider caps]** → Drive/S3 cap at 1000
per provider call; OneDrive at 999. The renderer asking for
`pageSize: 5000` results in the strategy issuing one capped
provider call and returning `nextCursor !== null` for the
remaining 4000. The "Load more" button must be auto-clicked or
the user has to click multiple times for one logical "page". For
v1, document this in `design_limitations.md`; auto-loop-to-target
is a future enhancement if it surfaces as a usability issue.

**[Sort-on-loaded-pages on S3 inconsistency]** → Once a user clicks
Load More on S3, sorting is by-page rather than globally. Documented
in `design_limitations.md`. Switching to server-side sort on S3 is
not feasible (no `orderBy` API); buffering all pages client-side
defeats the purpose of pagination.

## Migration Plan

This is a forward change, not a data migration. Deploy-time concerns:

- **Renderer-main version skew within the desktop bundle:** none —
  bundle is monolithic.
- **fs-sync RPC shape:** the new optional fields are
  forwards-compatible; an older renderer that omits `cursor` and
  `pageSize` continues to type-check and gets the new default
  page-size of 500 implicitly applied at the strategy layer (or the
  provider default if pageSize is omitted entirely).
- **Test fixtures:** strategy-contract test, IPC test-d, files-list
  unit test all need updates in the same change-set.
- **Rollback:** revert the change branch. The wire shape additions
  are optional, so a partial revert (renderer reverted, engine
  not) would still type-check.

## Open Questions

1. (Confirm during human review) Auto-retry interpretation: 4 total
   attempts (initial + 3 retries) at 2s/5s/7s waits per Decision 4.
   If you wanted 3 total attempts (initial + 2 retries) the timing
   collapses to one of {2,5}, {2,7}, or {5,7}; please confirm.
2. (Confirm during Visual Companion brainstorming) Whether the
   "Load more" affordance in icon-grid view modes should span the
   grid bottom as one wide button, or render as a centered button
   below the grid. The wider-button option is more discoverable but
   visually heavier.
3. (Defer) Whether to lift the auto-retry budget to a user setting.
   v1 hard-codes; if support feedback shows the 14s budget is too
   short for slow connections, surface as a Settings entry.
