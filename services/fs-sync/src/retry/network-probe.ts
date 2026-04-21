// NetworkProbe — a 30-second DNS probe that runs IFF one or more jobs are
// in `waiting-network`. Idle otherwise. On success, transitions every
// `waiting-network` row back to `queued` in a single UPDATE and emits a
// single `network-available` event.
//
// Spec: "Network probe is a 30-second DNS probe, active only while jobs
// are waiting".

import type Database from "better-sqlite3";
import * as dns from "node:dns/promises";

import type { EventBus } from "../events/event-bus.js";

export interface NetworkProbeOptions {
  readonly db: Database.Database;
  readonly bus: EventBus;
  /** Host to probe. Defaults to cloudflare.com. */
  readonly host?: string;
  /** Tick interval in ms. Defaults to 30_000. */
  readonly intervalMs?: number;
  /**
   * Test seam: resolver function. Defaults to `dns.resolve(host)`. Tests
   * inject a mocked resolver to drive success/failure paths deterministically.
   */
  readonly resolver?: (host: string) => Promise<string[]>;
}

export class NetworkProbe {
  private readonly db: Database.Database;
  private readonly bus: EventBus;
  private readonly host: string;
  private readonly intervalMs: number;
  private readonly resolver: (host: string) => Promise<string[]>;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private probeCount = 0;

  constructor(opts: NetworkProbeOptions) {
    this.db = opts.db;
    this.bus = opts.bus;
    this.host = opts.host ?? "cloudflare.com";
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.resolver = opts.resolver ?? ((h) => dns.resolve(h));
  }

  /**
   * Re-evaluate whether the probe should be armed. Call this on every
   * transition into or out of waiting-network. Cheap (one count query).
   */
  reconcile(): void {
    if (this.stopped) return;
    const count = this.countWaiting();
    if (count > 0 && this.timer === null) {
      this.arm();
    } else if (count === 0 && this.timer !== null) {
      this.disarm();
    }
  }

  /** Visible for tests. */
  isArmed(): boolean {
    return this.timer !== null;
  }

  /** Visible for tests. Count of probe ticks since start. */
  probeCountSoFar(): number {
    return this.probeCount;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.disarm();
  }

  private arm(): void {
    this.timer = setInterval(() => {
      void this.tick().catch(() => void 0);
    }, this.intervalMs);
    // First tick fires on a micro-delay so a freshly-added waiting-network
    // job doesn't immediately block the scheduler thread with a resolver.
    void Promise.resolve().then(() => this.tick()).catch(() => void 0);
  }

  private disarm(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.probeCount++;
    try {
      await this.resolver(this.host);
    } catch {
      return; // network still down — another tick will try.
    }
    this.releaseWaitingJobs();
  }

  private countWaiting(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM jobs WHERE status = 'waiting-network'`)
      .get() as { c: number };
    return row.c;
  }

  private releaseWaitingJobs(): void {
    // Collect the ids so the emitted event lists the exact set released.
    const rows = this.db
      .prepare(`SELECT id FROM jobs WHERE status = 'waiting-network'`)
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return;

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', updated_at = ?
         WHERE status = 'waiting-network'`,
      )
      .run(now);

    this.bus.emit("network-available", {
      host: this.host,
      observedAt: now,
      releasedJobIds: rows.map((r) => r.id),
    });

    this.disarm(); // nothing to watch until the next job enters waiting-network.
  }
}
