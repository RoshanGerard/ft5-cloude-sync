import type { PingResponse } from "@ft5/ipc-contracts";

// Pure handler for the `ping` IPC op. Intentionally has NO dependency on
// Electron: the unit test in `__tests__/ping.test.ts` imports this directly
// from Node. The `ipcMain.handle('ping', handlePing)` registration lives in
// `./index.ts` so that importing the handler in isolation never drags the
// `electron` module into a non-Electron process.
export function handlePing(): PingResponse {
  return {
    ok: true,
    ts: Date.now(),
  };
}
