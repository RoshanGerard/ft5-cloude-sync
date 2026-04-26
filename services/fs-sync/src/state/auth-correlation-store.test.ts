// Unit tests for the auth correlation store that binds
// `sync:authenticate-start` to `sync:authenticate-complete`.
// See openspec/changes/wire-fs-sync-service/design.md "Decision 10".
//
// The store is a pure in-memory map keyed by a correlation id. It holds live
// `AuthIntent` closures produced by `engine.authenticate(datasourceId)` and
// hands them back to the `authenticate-complete` handler. Closures cannot
// cross the socket; the correlation id does.
//
// The store is deliberately ignorant of kind-matching: `intent.kind` vs
// `completion.kind` is the caller's responsibility. Do not add that check
// here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthIntent } from "@ft5/fs-datasource-engine";

import {
  createAuthCorrelationStore,
  type AuthCorrelationStore,
} from "./auth-correlation-store.js";

const TTL_MS = 300_000; // 5 minutes — matches store default.

function makeOAuthIntent(authorizeUrl = "https://example.com/authorize"): AuthIntent {
  return {
    kind: "oauth",
    authorizeUrl,
    completeWith: async () => ({ accessToken: "token" }),
  };
}

function makeFormIntent(): AuthIntent {
  return {
    kind: "credentials-form",
    schema: { fields: [] },
    submit: async () => ({ accessToken: "token" }),
  };
}

describe("AuthCorrelationStore", () => {
  describe("without fake timers", () => {
    let store: AuthCorrelationStore;

    beforeEach(() => {
      store = createAuthCorrelationStore();
    });

    it("create + peek returns the stored intent unchanged", () => {
      const intent = makeOAuthIntent();
      const { correlationId } = store.create(intent);
      expect(correlationId).toBeTypeOf("string");
      expect(correlationId.length).toBeGreaterThan(0);
      // Same reference — no cloning, closures must survive.
      expect(store.peek(correlationId)).toBe(intent);
    });

    it("two create calls return distinct correlation ids", () => {
      const a = store.create(makeOAuthIntent());
      const b = store.create(makeOAuthIntent());
      expect(a.correlationId).not.toBe(b.correlationId);
    });

    it("consume returns the intent and removes it", () => {
      const intent = makeOAuthIntent();
      const { correlationId } = store.create(intent);
      expect(store.consume(correlationId)).toBe(intent);
      expect(store.consume(correlationId)).toBeUndefined();
      expect(store.peek(correlationId)).toBeUndefined();
      expect(store.size()).toBe(0);
    });

    it("peek does not remove the entry", () => {
      const intent = makeOAuthIntent();
      const { correlationId } = store.create(intent);
      expect(store.peek(correlationId)).toBe(intent);
      expect(store.peek(correlationId)).toBe(intent);
      expect(store.size()).toBe(1);
    });

    it("peek / consume for an unknown correlation id return undefined, never throw", () => {
      expect(() => store.peek("nonsense")).not.toThrow();
      expect(() => store.consume("nonsense")).not.toThrow();
      expect(store.peek("nonsense")).toBeUndefined();
      expect(store.consume("nonsense")).toBeUndefined();
    });

    it("accepts oauth and credentials-form intents without kind-specific logic", () => {
      const oauth = makeOAuthIntent();
      const form = makeFormIntent();
      const a = store.create(oauth);
      const b = store.create(form);
      // The store must return whatever was handed in — no kind check here.
      expect(store.peek(a.correlationId)).toBe(oauth);
      expect(store.peek(b.correlationId)).toBe(form);
    });

    // Surface change for implement-datasource-onboarding §9: the handler
    // mints a single correlationId at the top, emits `auth-initiated`, and
    // hands the same id to whichever store/broker holds the live intent.
    it("createWith uses the supplied correlationId verbatim", () => {
      const intent = makeFormIntent();
      const { correlationId } = store.createWith("corr-pre-minted-1", intent);
      expect(correlationId).toBe("corr-pre-minted-1");
      expect(store.peek("corr-pre-minted-1")).toBe(intent);
    });

    it("createWith honours peek, consume, and TTL eviction like create", () => {
      const intent = makeFormIntent();
      store.createWith("corr-A", intent);
      expect(store.size()).toBe(1);
      expect(store.consume("corr-A")).toBe(intent);
      expect(store.size()).toBe(0);
    });

    it("createWith throws when the correlationId is already in use", () => {
      const intent1 = makeFormIntent();
      const intent2 = makeFormIntent();
      store.createWith("corr-dup", intent1);
      expect(() => store.createWith("corr-dup", intent2)).toThrow(
        /already in use/,
      );
      // First entry is unchanged.
      expect(store.peek("corr-dup")).toBe(intent1);
    });

    it("injected randomUUID seam is used for correlation ids", () => {
      let i = 0;
      const ids = ["uuid-a", "uuid-b"];
      const seeded = createAuthCorrelationStore({
        randomUUID: () => ids[i++]!,
      });
      expect(seeded.create(makeOAuthIntent()).correlationId).toBe("uuid-a");
      expect(seeded.create(makeOAuthIntent()).correlationId).toBe("uuid-b");
    });
  });

  describe("TTL behaviour (fake timers)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("entry is evicted after the TTL elapses; peek/consume return undefined and the internal map is empty", () => {
      const store = createAuthCorrelationStore();
      const { correlationId } = store.create(makeOAuthIntent());
      expect(store.size()).toBe(1);

      vi.advanceTimersByTime(TTL_MS + 1);

      expect(store.peek(correlationId)).toBeUndefined();
      expect(store.consume(correlationId)).toBeUndefined();
      expect(store.size()).toBe(0);
    });

    it("consume before TTL clears the timer so a late fire does not throw or mutate state", () => {
      const store = createAuthCorrelationStore();
      const intent = makeOAuthIntent();
      const { correlationId } = store.create(intent);

      expect(store.consume(correlationId)).toBe(intent);
      expect(store.size()).toBe(0);

      // Advance well past the TTL. If the timer wasn't cleared, any attempt
      // to mutate internal state or emit something would surface here.
      expect(() => {
        vi.advanceTimersByTime(TTL_MS * 2);
      }).not.toThrow();
      expect(store.size()).toBe(0);
    });

    it("multiple entries coexist and all expire at their own TTL", () => {
      const store = createAuthCorrelationStore();
      const a = store.create(makeOAuthIntent("https://a"));
      const b = store.create(makeOAuthIntent("https://b"));
      const c = store.create(makeFormIntent());

      vi.advanceTimersByTime(250_000); // below TTL
      expect(store.peek(a.correlationId)).toBeDefined();
      expect(store.peek(b.correlationId)).toBeDefined();
      expect(store.peek(c.correlationId)).toBeDefined();
      expect(store.size()).toBe(3);

      vi.advanceTimersByTime(100_000); // now past 300_000 total
      expect(store.peek(a.correlationId)).toBeUndefined();
      expect(store.peek(b.correlationId)).toBeUndefined();
      expect(store.peek(c.correlationId)).toBeUndefined();
      expect(store.size()).toBe(0);
    });

    it("custom ttlMs option is honoured", () => {
      const store = createAuthCorrelationStore({ ttlMs: 1_000 });
      const { correlationId } = store.create(makeOAuthIntent());
      vi.advanceTimersByTime(999);
      expect(store.peek(correlationId)).toBeDefined();
      vi.advanceTimersByTime(2);
      expect(store.peek(correlationId)).toBeUndefined();
    });
  });
});
