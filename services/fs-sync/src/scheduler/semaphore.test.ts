import { describe, expect, it } from "vitest";

import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  it("allows exactly `permits` concurrent acquires without blocking", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.availablePermits()).toBe(0);
  });

  it("a third acquire waits until a permit is released", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();

    let resolved = false;
    const third = sem.acquire().then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);

    sem.release();
    await third;
    expect(resolved).toBe(true);
  });

  it("release order is FIFO for waiters", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: string[] = [];
    const a = sem.acquire().then(() => {
      order.push("a");
    });
    const b = sem.acquire().then(() => {
      order.push("b");
    });
    const c = sem.acquire().then(() => {
      order.push("c");
    });

    await new Promise((r) => setTimeout(r, 5));
    sem.release(); // releases a
    await a;
    sem.release(); // releases b
    await b;
    sem.release(); // releases c
    await c;

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("rejects permits < 1", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
  });

  it("totalPermits is immutable over the lifetime", async () => {
    const sem = new Semaphore(3);
    expect(sem.totalPermits()).toBe(3);
    await sem.acquire();
    expect(sem.totalPermits()).toBe(3);
    expect(sem.availablePermits()).toBe(2);
  });
});
