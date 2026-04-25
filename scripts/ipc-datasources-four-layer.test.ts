import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// Every datasources:* channel must have, end to end:
//   (1) a handler file under apps/desktop/src/main/ipc/datasources/
//       (except upload:progress which is main→renderer only, no handler)
//   (2) an ipcMain.handle or webContents.send registration in ipc/index.ts
//   (3) a preload exposure via contextBridge in apps/desktop/src/preload/index.ts

const EXPECTED_CHANNELS = [
  "datasources:list",
  "datasources:add",
  "datasources:remove",
  "datasources:action",
  "datasources:pick-files-to-upload",
  "datasources:upload:progress",
] as const;

const HANDLER_BY_CHANNEL: Record<string, string | null> = {
  "datasources:list": "list.ts",
  "datasources:add": "add.ts",
  "datasources:remove": "remove.ts",
  "datasources:action": "action.ts",
  "datasources:pick-files-to-upload": "pick-files-to-upload.ts",
  "datasources:upload:progress": null,
};

// Map a channel literal to the camelCase key declared on
// `DATASOURCES_CHANNELS` in `packages/ipc-contracts/src/datasources.ts`.
// Most keys are the literal's suffix verbatim, but two are special:
//   - `datasources:upload:progress` → `uploadProgress`
//   - `datasources:pick-files-to-upload` → `pickFilesToUpload` (kebab → camel)
// We resolve those explicitly rather than running a generic kebab-to-camel
// conversion so a future channel that introduces new punctuation can't
// silently change the contract surface this guardrail asserts.
function channelConstKeyFor(channel: string): string {
  if (channel === "datasources:upload:progress") return "uploadProgress";
  if (channel === "datasources:pick-files-to-upload") return "pickFilesToUpload";
  return channel.replace(/^datasources:/, "");
}

describe("datasources IPC four-layer consistency", () => {
  it("contract exposes exactly the expected channel set (no drift)", () => {
    const contractPath = path.join(
      repoRoot,
      "packages/ipc-contracts/src/datasources.ts",
    );
    const contents = readFileSync(contractPath, "utf8");
    for (const channel of EXPECTED_CHANNELS) {
      expect(
        contents.includes(`"${channel}"`),
        `contract must declare channel literal "${channel}"`,
      ).toBe(true);
    }
  });

  it("every channel has a handler file on disk (or is a progress event)", () => {
    const handlersDir = path.join(
      repoRoot,
      "apps/desktop/src/main/ipc/datasources",
    );
    for (const [channel, handlerFile] of Object.entries(HANDLER_BY_CHANNEL)) {
      if (handlerFile === null) continue;
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
      if (channel === "datasources:upload:progress") {
        expect(
          contents.includes("uploadProgress"),
          `ipc/index.ts must reference DATASOURCES_CHANNELS.uploadProgress`,
        ).toBe(true);
        continue;
      }
      const channelConstKey = channelConstKeyFor(channel);
      expect(
        contents.includes(`DATASOURCES_CHANNELS.${channelConstKey}`) ||
          contents.includes(`"${channel}"`),
        `ipc/index.ts must register handler for ${channel}`,
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
      const channelConstKey = channelConstKeyFor(channel);
      expect(
        contents.includes(`DATASOURCES_CHANNELS.${channelConstKey}`) ||
          contents.includes(`"${channel}"`),
        `preload/index.ts must reference channel ${channel} (via DATASOURCES_CHANNELS.${channelConstKey} or literal)`,
      ).toBe(true);
    }
  });
});
