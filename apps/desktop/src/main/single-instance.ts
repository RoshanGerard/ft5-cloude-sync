// Pure helper for the single-instance lock branch. Extracted from `index.ts`
// so the decision (acquire vs. exit) is covered by a fast unit test without
// booting Electron. See `openspec/changes/setup-project/specs/app-shell/spec.md`
// Requirement 1, scenario "Second instance prevented".

export interface AppLike {
  requestSingleInstanceLock(): boolean;
  exit(code?: number): void;
}

export function enforceSingleInstance(app: AppLike): "acquired" | "exited" {
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return "exited";
  }
  return "acquired";
}
