// Hand-rolled async semaphore. FIFO release order. No dependencies.
//
// Spec: "Global concurrency is capped at 2 via a semaphore" — the
// scheduler uses a 2-permit instance by default and a 1-permit instance
// when `allowParallel: false`.

export class Semaphore {
  private readonly total: number;
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new Error(`permits must be >= 1 (got ${permits})`);
    this.total = permits;
    this.available = permits;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.available--;
  }

  release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) {
      // The waiter's await returns; the same waiter then decrements
      // `available` itself. We need to pre-decrement to prevent a race
      // where a new acquirer sneaks in before the waiter's microtask.
      this.available--;
      next();
    }
  }

  availablePermits(): number {
    return this.available;
  }

  totalPermits(): number {
    return this.total;
  }
}
