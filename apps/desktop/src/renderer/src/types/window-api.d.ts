// Renderer-scoped ambient for `window.api`. The preload has its own copy of
// this declaration (apps/desktop/src/preload/window-api.d.ts) that lives in
// the preload tsconfig; this file is the renderer's canonical source and is
// intentionally not shared, so renderer code never picks up Node/Electron
// types through the preload's `.d.ts`.
import type { PingResponse } from "@ft5/ipc-contracts";

declare global {
  interface Window {
    api: {
      ping(): Promise<PingResponse>;
    };
  }
}

export {};
