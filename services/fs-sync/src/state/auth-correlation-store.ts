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

const DEFAULT_TTL_MS = 300_000; // 5 minutes — see design.md Decision 10.

export interface AuthCorrelationStore {
  create(intent: AuthIntent): { correlationId: string };
  peek(correlationId: string): AuthIntent | undefined;
  consume(correlationId: string): AuthIntent | undefined;
  size(): number;
}

export interface AuthCorrelationStoreOptions {
  ttlMs?: number;
  nowMs?: () => number;
  randomUUID?: () => string;
}

interface Entry {
  intent: AuthIntent;
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
    const correlationId = randomUUID();
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

  function size(): number {
    return entries.size;
  }

  return { create, peek, consume, size };
}
