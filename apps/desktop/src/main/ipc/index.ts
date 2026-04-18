import { ipcMain } from "electron";
import { handlePing } from "./ping.js";

// Central IPC handler registration. Called once from `main/index.ts` after
// `app.whenReady()`. Keeping the `ipcMain.handle` calls here (rather than
// beside each handler) isolates the Electron import from the pure handlers,
// so those handlers can be unit-tested under plain Node.
export function registerIpcHandlers(): void {
  ipcMain.handle("ping", () => handlePing());
}
