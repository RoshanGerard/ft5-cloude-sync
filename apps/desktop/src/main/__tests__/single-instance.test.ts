import { describe, expect, it, vi } from "vitest";
import { enforceSingleInstance, type AppLike } from "../single-instance";

describe("enforceSingleInstance", () => {
  it("returns 'acquired' when the lock is obtained and does not exit", () => {
    const exit = vi.fn();
    const app: AppLike = {
      requestSingleInstanceLock: () => true,
      exit,
    };

    const result = enforceSingleInstance(app);

    expect(result).toBe("acquired");
    expect(exit).not.toHaveBeenCalled();
  });

  it("returns 'exited' and calls exit(0) exactly once when another instance holds the lock", () => {
    const exit = vi.fn();
    const app: AppLike = {
      requestSingleInstanceLock: () => false,
      exit,
    };

    const result = enforceSingleInstance(app);

    expect(result).toBe("exited");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
