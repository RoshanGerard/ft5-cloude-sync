import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// Every files:* channel must have, end to end:
//   (1) a contract literal in packages/ipc-contracts/src/files.ts
//   (2) a handler file under apps/desktop/src/main/ipc/files/
//   (3) an ipcMain.handle registration in apps/desktop/src/main/ipc/index.ts
//   (4) a preload exposure via contextBridge in apps/desktop/src/preload/index.ts
//
// This sibling to ipc-datasources-four-layer.test.ts is deliberately separate:
// the two IPC surfaces grow at different paces, and keeping the expected
// channel set owned by each surface's own guardrail keeps drift in one surface
// from silently masking drift in the other.

const EXPECTED_CHANNELS = [
  "files:list",
  "files:stat",
  "files:search",
  "files:rename",
  "files:remove",
  "files:download",
] as const;

const HANDLER_BY_CHANNEL: Record<string, string> = {
  "files:list": "list.ts",
  "files:stat": "stat.ts",
  "files:search": "search.ts",
  "files:rename": "rename.ts",
  "files:remove": "remove.ts",
  "files:download": "download.ts",
};

describe("files IPC four-layer consistency", () => {
  it("contract exposes exactly the expected channel set (no drift)", () => {
    const contractPath = path.join(
      repoRoot,
      "packages/ipc-contracts/src/files.ts",
    );
    const contents = readFileSync(contractPath, "utf8");
    for (const channel of EXPECTED_CHANNELS) {
      expect(
        contents.includes(`"${channel}"`),
        `contract must declare channel literal "${channel}"`,
      ).toBe(true);
    }
  });

  it("every channel has a handler file on disk", () => {
    const handlersDir = path.join(
      repoRoot,
      "apps/desktop/src/main/ipc/files",
    );
    for (const [channel, handlerFile] of Object.entries(HANDLER_BY_CHANNEL)) {
      const fullPath = path.join(handlersDir, handlerFile);
      expect(
        existsSync(fullPath),
        `channel ${channel} expects handler at ${fullPath}`,
      ).toBe(true);
    }
  });

  it("ipc/index.ts registers every channel with ipcMain.handle", () => {
    const indexPath = path.join(repoRoot, "apps/desktop/src/main/ipc/index.ts");
    const contents = readFileSync(indexPath, "utf8");
    for (const channel of EXPECTED_CHANNELS) {
      const channelConstKey = channel.replace(/^files:/, "");
      expect(
        contents.includes(`FILES_CHANNELS.${channelConstKey}`) ||
          contents.includes(`"${channel}"`),
        `ipc/index.ts must register handler for ${channel} ` +
          `(via FILES_CHANNELS.${channelConstKey} or literal)`,
      ).toBe(true);
    }
  });

  it("preload/index.ts exposes every channel via contextBridge", () => {
    const preloadPath = path.join(
      repoRoot,
      "apps/desktop/src/preload/index.ts",
    );
    const contents = readFileSync(preloadPath, "utf8");
    for (const channel of EXPECTED_CHANNELS) {
      const channelConstKey = channel.replace(/^files:/, "");
      expect(
        contents.includes(`FILES_CHANNELS.${channelConstKey}`) ||
          contents.includes(`"${channel}"`),
        `preload/index.ts must reference channel ${channel} ` +
          `(via FILES_CHANNELS.${channelConstKey} or literal)`,
      ).toBe(true);
    }
  });
});
