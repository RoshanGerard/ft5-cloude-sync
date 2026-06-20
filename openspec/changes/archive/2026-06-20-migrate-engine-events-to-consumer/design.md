# Design: Remove the engine `EventBus`; consumers own event emission

## Context

The `fs-datasource-engine` owns an `EventBus` (`packages/fs-datasource-engine/src/event-bus.ts`) with streaming coalescing (1s OR 10% progress delta), injected into every strategy via `ctx.bus`. The base class `BaseDatasourceClient` is the sole emitter: a single private `emit()` (`base-client.ts:1094-1108`) fronts ~21 call sites covering 13 event names. Strategies emit nothing directly (enforced today by a guard test). The bus is bridged to the renderer in two unrelated places, only one of which is live.

**Verified current state (mapped 2026-06-19 against the code, not the stale 2026-04-28 stub):**

- **Live consumer — exactly one.** `services/fs-sync/src/commands/files-download.ts:753` subscribes to capture the `downloading` streaming event and re-emit a transformed `downloading` on the fs-sync IPC stream (`fsSyncBus`). The download *terminal* events are emitted by the handler's own synchronous path (`files-download.ts:793-799` — "the synchronous path is authoritative"), NOT relayed from the bus. Repo-wide grep finds no other `engineBus.subscribe`.
- **Dead consumer — the desktop `datasources:event` bridge.** `apps/desktop/src/main/ipc/datasources/event-bridge.ts` subscribes to `getEngine().bus`, but desktop main never instantiates engine clients (every `getEngine()` reads `.registry`/`.factory`; `action.test`/`remove.test` even assert `factory.create` is *not* called). So nothing emits onto that bus. The renderer hook `useDatasourceEvents` (`renderer/src/features/datasources/event-stream.ts`) has **zero** production callers; `store-auth.test.tsx` documents that the `consent-*` family on `datasources.onEvent` was retired for `auth-*` on `sync.onEvent`.
- **The other 12 events** (`authenticated`/`authentication-failed`/`token-refreshed`/`token-expired`, `deleted`/`delete-failed`/`entry-renamed`, `status-changed`/`rate-limited`, download-terminal) have no live subscriber. The renderer's `auth-*` events come from fs-sync's *own* service bus (`loopback-broker` + command handlers emit on `deps.bus` independently of the engine bus); the file explorer updates from RPC responses + the optimistic store.

`engine.downloadFile` already exposes `options.onProgress(loaded, total)` (`base-client.ts:113-116`); the strategy byte-counting hook already fires *both* `onProgress` and `emitDownloading`. The throttle that bounds progress lives only in the bus coalescer; the fs-sync handler relies on it today (`files-download.ts:774-775`: "throttled by the engine bus's 1s/10pct coalescer, so writes are bounded").

## Goals / Non-Goals

**Goals:**
- Remove the engine `EventBus` entirely; engine methods return values or throw normalized `DatasourceError` with no bus side effects.
- Relocate download-progress throttling (1s OR 10%, flush-before-terminal) into the fs-sync download handler, consuming `options.onProgress`.
- Full cleanup of the dead desktop `datasources:event` path (channel, preload exposure, renderer hook, orphaned types).
- Preserve all renderer-observable behavior: surviving events still flow via `sync.onEvent`; UX unchanged.

**Non-Goals:**
- Changing wire-level event names/shapes the renderer observes via `sync.onEvent` (`auth-*`, download progress) — identical.
- Adding mid-operation token-refresh notification to the renderer (current behavior is "not notified on silent mid-op refresh" — preserved).
- Re-homing `deleted`/`entry-renamed`/`status-changed` to any new channel — no consumer wants them.
- Touching the `CredentialStore` port or the `withAuthRefresh` helper.
- Directory-delete unification (that is `unify-engine-delete-method`).

## Decisions

### Decision 1 — Remove the `EventBus` entirely (not "deprecate")
Delete `event-bus.ts`; remove the private `emit()` + all ~21 call sites in `base-client.ts`; remove the `bus` field from `EngineContext` (`factory.ts:88-91`) and `BaseClientContext` (`base-client.ts:268-272`); remove `createEventBus`/`EventBus`/`EventBusOptions`/`Clock`/`ClockTimer` from `index.ts`. **Alternative considered:** keep the bus but stop emitting domain events — rejected; that leaves dead infrastructure and the very coupling this change exists to remove. The bus has no surviving justification once `downloading` moves to `onProgress`.

### Decision 2 — Download progress via `options.onProgress`, with throttle relocated to the fs-sync handler (the one substantive technical decision)
The fs-sync download handler stops subscribing to the engine bus and consumes `engine.downloadFile(target, { …, onProgress })`. Because the engine coalescer is gone and `onProgress` fires at raw SDK-chunk frequency, the handler MUST own a small progress coalescer: throttle at **1 second OR 10% progress delta**, and **flush the last pending progress update before emitting the terminal event** so the final byte count (typically 100%) is never dropped or reordered ahead of `file-downloaded`/`download-failed`/`download-cancelled`. The throttle governs the **`downloading` IPC emission** (the renderer-flooding concern). The registry's `bytesDownloaded` continues to update on **every** `onProgress` tick, NOT behind the throttle — the cancel/failure terminal paths read the registry for the byte count in their payloads, and `downloads:list-active` is a snapshot, so both want the latest tick, not a throttled value. (Refined during apply: an earlier draft put the registry write behind the throttle too; that would force a flush-before-read on the cancel path and risk the resume byte-counting, for no observable gain — the live progress the renderer sees is the throttled `downloading` stream, which is unaffected.) The coalescer is tick-driven (no background timer): it emits on a tick when ≥1 s elapsed or the 10% threshold is crossed, holds the rest as pending, and `flush()` emits the pending before each terminal — sufficient because a stalled stream produces no new progress and completion routes through flush-on-terminal. The engine's `downloadFile` loses all bus emissions (the `emitDownloading` bus emit *and* the terminal `emitTerminal` logic at `base-client.ts:806-858`); fs-sync already owns terminal emission via its synchronous path and tracks its own bytes (`bytesWritten`). During apply, evaluate whether the engine's `activeDownloads`/`recordProgress` machinery (which existed to populate terminal-event byte counts *from the bus path*) can be removed once terminal bus emissions are gone — keep the `onProgress` invocation itself. **Alternative considered:** raw un-throttled `onProgress` straight to the IPC stream — rejected; floods the renderer at chunk frequency (a regression, not a refactor).

### Decision 3 — No auth/state re-homing
The engine's auth-cycle emissions and `deleted`/`delete-failed`/`entry-renamed`/`status-changed`/`rate-limited` have no live consumer. The renderer's `auth-*` events are emitted independently by fs-sync's service bus; file state comes from RPC responses + the optimistic store. Removing these engine emissions therefore loses **no observable behavior** and nothing moves to a new channel. This is the central correctness argument: the change is safe precisely because these emissions are already unobserved.

### Decision 4 — Full cleanup of the dead desktop `datasources:event` path (user-approved)
Removing `bus` from `EngineContext` is a compile break at `createEventBridge(getEngine().bus)`, so unwiring the desktop datasources bridge is *forced*. Per the approved scope, also delete the orphaned remainder: the `DATASOURCES_CHANNELS.event` channel (`ipc-contracts/datasources.ts`), `window.api.datasources.onEvent` (preload `index.ts` + both `window-api.d.ts`), the `useDatasourceEvents` hook (`event-stream.ts`), the `bus` field on the desktop `Engine` singleton (`datasources/engine.ts`), and the now-unused event types (`AnyDatasourceEvent`/`DatasourceEvent`/`PayloadMap`/`CanonicalEventPayloads`) + their index re-exports. During apply, grep-verify no surviving importer before deleting each type. **Alternative considered:** runtime-only / minimal cleanup — rejected by the user in favor of leaving no dead code.

### Decision 5 — `CredentialStore` port and `withAuthRefresh` unchanged
Credential persistence is a *port*, not a bus event. The auth flow keeps `persistCredentials → ctx.credentialStore.put` (`refreshCredentials` ~968, `completeAuth` ~1085); only the post-`put` event emission is removed. `withAuthRefresh` (`with-auth-refresh.ts`) never touched the bus — unchanged.

### Decision 6 — `dispose()` is out of scope
`dispose()` is already a contract-stable no-op across base + strategies (post `migrate-engine-cache-invalidation`). Removing it is trivial but not required by this change; leave it unless its removal falls out naturally during apply.

### Decision 7 — Correct pre-existing spec drift in passing
The canonical engine spec still carries stale content (the "Strategy LRU path-handle invalidation on upload completion is internal" requirement says strategies "retain the `deleted` arm … deleteFile continues to emit `deleted` on the engine bus" and has a "via engine bus subscription" scenario) that contradicts the merged `migrate-engine-cache-invalidation` (eviction is inline). This change's engine delta corrects that drift as part of removing the bus, since the requirement is being rewritten anyway.

## Risks / Trade-offs

- **Download-progress throttle relocation is the one behavioral risk** → Mitigation: implement the handler coalescer (1s/10% + flush-before-terminal) test-first; cover bounded-emission cadence and the final-100%-before-terminal ordering explicitly. This is the only place a regression can hide.
- **Loses the cross-process `datasources:event` notification path** → Not load-bearing: it has no production emitter or consumer today. Mitigation: none needed; documented in Decision 3.
- **Removing public types is a breaking package-surface change** → Mitigation: only the now-removed dead path imports them; apply-time grep confirms before each deletion.
- **DRY** → the engine coalescer's streaming logic is reimplemented (smaller, single-purpose) in the fs-sync handler. Lean YAGNI — download is the only streaming consumer; do NOT extract a shared util.
- **Canonical Purpose prose** → the engine spec's `## Purpose` paragraph mentions "the typed event bus with its streaming-throttle semantics." The OpenSpec delta format edits Requirements, not the Purpose prose; fix the Purpose line during `/opsx:sync`/archive so the canonical reads cleanly.
- **Fourth capability surfaced during scope verification** → a repo-wide grep for the removed surface (`datasources:event`, `EventBus`, etc.) found `fs-sync-supervisor` also references `datasources:event`: its "Service events are relayed to the renderer" requirement has a stale "(distinct from the existing `datasources:event` channel)" parenthetical, and its "Datasource cards reflect live service job state" requirement derives card display from "(a) `datasources:event` + (b) the sync stream." Both are in this change's `fs-sync-supervisor` delta (drop the parenthetical; drop source (a)). This is the same card-state concern the `datasources-ui` delta also corrects — the two capabilities carry parallel card requirements; both now derive from the sync stream + seed only.
- **Loopback-broker incidental staleness (NOT fixed here — documented)** → `fs-sync-service`'s "OAuthLoopbackBroker" requirement says the broker emits `oauth-open-url` "on the engine bus" (L539) and a scenario stubs "an engine bus" (L551). The broker actually emits its auth events on the fs-sync *service* bus, not the engine bus — so the "engine bus" wording is a PRE-EXISTING mislabel, and the broker's behavior is unchanged by removing the engine bus. The `createForAuth` `ctx` the broker threads does drop its `bus` field (per the engine delta), making the test's "stubbed engine bus" phrasing stale. Left out of scope: the broker requirement is a security-relevant OAuth/CSRF block, the references are phrasing/test-harness detail (not contract behavior), and a full verbatim-copy MODIFY to fix two phrases carries more risk than the staleness. Correct when that requirement is next materially edited.

## Migration Plan

Single change, applied in a worktree under TDD with code review between slices. Suggested slice order (see `tasks.md`): (1) fs-sync handler `onProgress` + throttle (test-first — protects the one risk before the bus is gone), (2) engine bus removal + `EngineContext`/exports, (3) `ipc-contracts` type/channel removal, (4) desktop main + preload + renderer dead-path deletion, (5) test sweep, (6) verification + `validate --strict` + per-cap spec validate. No runtime data migration; no rollback complexity beyond standard branch revert. No new dependency.

## Open Questions

_None — the architecture was resolved during brainstorming (advisor checkpoint #1 cleared the vestigial-bus reading and the throttle-relocation requirement)._
