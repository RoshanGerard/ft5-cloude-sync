// In-memory correlation store binding `sync:authenticate-start` to
// `sync:authenticate-complete`. See openspec/changes/wire-fs-sync-service/
// design.md "Decision 10".
//
// Why this exists: `engine.authenticate(datasourceId)` returns an
// `AuthIntent` carrying closures (`completeWith`, `submit`) that cannot
// cross the newline-delimited-JSON socket. We stash the live intent
// here, hand the caller a short-lived correlation id, and the paired
// complete command looks it back up.
//
// Lifecycle:
// - Each entry self-expires via a `setTimeout(…, ttlMs)` scheduled at
//   create time. On fire, the entry is silently removed from the map —
//   no logs, no events. Silent eviction keeps the OAuth code / form
//   values off any disk.
// - `consume` clears the per-entry timer before returning so a late
//   firing cannot mutate state.
// - The timer handle has `.unref()` called where supported so a
//   lingering intent never keeps the service process alive.
// - No persistence. On service restart the map evaporates and any
//   desktop still holding a correlation id surfaces `correlation-expired`
//   on its next complete call.
//
// Security:
// - No credential storage; no logging of intent payloads; no filesystem
//   access. The store is intentionally ignorant of `AuthIntent.kind` —
//   kind-matching (oauth vs credentials-form) is the caller's job.

import { randomUUID as defaultRandomUUID } from "node:crypto";

import type { AuthIntent } from "@ft5/fs-datasource-engine";
import type { ProviderId } from "@ft5/ipc-contracts";

const DEFAULT_TTL_MS = 300_000; // 5 minutes — see design.md Decision 10.

/**
 * Per-entry metadata threaded by the §9 handler so the §10 complete handler
 * can build the response `DatasourceSummary` (which carries
 * `id` = the §9-minted datasourceId and `providerId` from the start request)
 * without a separate registry lookup. The §9 handler stashes both alongside
 * the live intent at `createWith` time; §10 reads them via `consume`.
 *
 * The store is intentionally agnostic of the metadata's contents — it
 * does not validate any field. Callers that don't supply metadata
 * (legacy `create(intent)`) get `undefined` back from `consume`.
 */
export interface AuthCorrelationMetadata {
  readonly datasourceId: string;
  readonly providerId: ProviderId;
}

export interface AuthCorrelationEntry {
  readonly intent: AuthIntent;
  readonly metadata?: AuthCorrelationMetadata;
}

export interface AuthCorrelationStore {
  create(intent: AuthIntent): { correlationId: string };
  /**
   * Like `create`, but uses the caller-supplied `correlationId` instead of
   * minting a fresh one. Used by the §9 `sync:authenticate-start` handler
   * so the same id flows through `auth-initiated` (handler emit) and
   * `auth-completed` (handler emit on §10) without two competing minters.
   *
   * Throws when the supplied id is already in use — the handler MUST
   * supply a unique id (it mints once and uses it for either the OAuth
   * broker OR this store, never both).
   *
   * The optional `metadata` parameter stashes (datasourceId, providerId)
   * alongside the live intent so the §10 complete handler can build the
   * response summary without a separate lookup.
   */
  createWith(
    correlationId: string,
    intent: AuthIntent,
    metadata?: AuthCorrelationMetadata,
  ): { correlationId: string };
  peek(correlationId: string): AuthIntent | undefined;
  consume(correlationId: string): AuthIntent | undefined;
  /**
   * Like `consume`, but returns both the intent and the metadata stashed
   * with `createWith(..., metadata)`. Used by the §10 complete handler.
   */
  consumeEntry(correlationId: string): AuthCorrelationEntry | undefined;
  size(): number;
}

export interface AuthCorrelationStoreOptions {
  ttlMs?: number;
  nowMs?: () => number;
  randomUUID?: () => string;
}

interface Entry {
  intent: AuthIntent;
  metadata?: AuthCorrelationMetadata;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export function createAuthCorrelationStore(
  options: AuthCorrelationStoreOptions = {},
): AuthCorrelationStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const randomUUID = options.randomUUID ?? (() => defaultRandomUUID());

  const entries = new Map<string, Entry>();

  function create(intent: AuthIntent): { correlationId: string } {
    return createWith(randomUUID(), intent);
  }

  function createWith(
    correlationId: string,
    intent: AuthIntent,
    metadata?: AuthCorrelationMetadata,
  ): { correlationId: string } {
    if (entries.has(correlationId)) {
      throw new Error(
        `AuthCorrelationStore.createWith: correlationId already in use: ${correlationId}`,
      );
    }
    const timer = setTimeout(() => {
      // Silent eviction; no logging, no events. If the entry was already
      // consumed before this fired, `delete` on a missing key is a no-op.
      entries.delete(correlationId);
    }, ttlMs);
    // Don't keep the service process alive on an expiring intent.
    // `unref` exists on Node's Timeout; guard for environments (e.g.,
    // fake-timer shims) that don't expose it.
    (timer as { unref?: () => void }).unref?.();

    entries.set(correlationId, {
      intent,
      ...(metadata !== undefined ? { metadata } : {}),
      createdAt: nowMs(),
      timer,
    });
    return { correlationId };
  }

  function peek(correlationId: string): AuthIntent | undefined {
    return entries.get(correlationId)?.intent;
  }

  function consume(correlationId: string): AuthIntent | undefined {
    const entry = entries.get(correlationId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    entries.delete(correlationId);
    return entry.intent;
  }

  function consumeEntry(
    correlationId: string,
  ): AuthCorrelationEntry | undefined {
    const entry = entries.get(correlationId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    entries.delete(correlationId);
    return {
      intent: entry.intent,
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    };
  }

  function size(): number {
    return entries.size;
  }

  return { create, createWith, peek, consume, consumeEntry, size };
}
