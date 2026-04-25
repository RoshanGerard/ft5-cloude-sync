// Task 8.2 — `datasources.pickFilesToUpload` four-layer wiring guardrail.
//
// Asserts the channel that replaces the retired `datasources:upload` is wired
// end-to-end:
//   (1) Contract:        `packages/ipc-contracts/src/datasources.ts` declares
//                        the `"datasources:pick-files-to-upload"` literal AND
//                        exports `DatasourcesPickFilesRequest` +
//                        `DatasourcesPickFilesResponse`.
//   (2) Handler:         `apps/desktop/src/main/ipc/datasources/pick-files-to-upload.ts`
//                        exists.
//   (3) Preload binding: `apps/desktop/src/preload/index.ts` exposes
//                        `pickFilesToUpload` on the `datasources` namespace
//                        and references the channel constant or literal.
//   (4) Renderer call:   at least one file under `apps/desktop/src/renderer/`
//                        (excluding `__tests__/`) calls `.pickFilesToUpload(`.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../..");

describe("datasources.pickFilesToUpload four-layer wiring", () => {
  it("repo-root resolution sanity check (package.json exists at repoRoot)", () => {
    expect(existsSync(path.join(repoRoot, "package.json"))).toBe(true);
  });

  it("(1) contract declares the channel literal AND exports the types", () => {
    const contractPath = path.join(
      repoRoot,
      "packages/ipc-contracts/src/datasources.ts",
    );
    const contents = readFileSync(contractPath, "utf8");
    expect(
      contents.includes(`"datasources:pick-files-to-upload"`),
      `datasources.ts must declare the channel literal "datasources:pick-files-to-upload"`,
    ).toBe(true);
    expect(
      /export\s+(?:interface|type)\s+DatasourcesPickFilesRequest\b/.test(
        contents,
      ),
      `datasources.ts must export type DatasourcesPickFilesRequest`,
    ).toBe(true);
    expect(
      /export\s+(?:interface|type)\s+DatasourcesPickFilesResponse\b/.test(
        contents,
      ),
      `datasources.ts must export type DatasourcesPickFilesResponse`,
    ).toBe(true);
  });

  it("(2) handler file exists at apps/desktop/src/main/ipc/datasources/pick-files-to-upload.ts", () => {
    const handlerPath = path.join(
      repoRoot,
      "apps/desktop/src/main/ipc/datasources/pick-files-to-upload.ts",
    );
    expect(
      existsSync(handlerPath),
      `expected handler file at ${handlerPath}`,
    ).toBe(true);
  });

  it("(3) preload exposes pickFilesToUpload on the datasources namespace", () => {
    const preloadPath = path.join(
      repoRoot,
      "apps/desktop/src/preload/index.ts",
    );
    const contents = readFileSync(preloadPath, "utf8");
    expect(
      contents.includes("DATASOURCES_CHANNELS.pickFilesToUpload") ||
        contents.includes(`"datasources:pick-files-to-upload"`),
      `preload/index.ts must reference DATASOURCES_CHANNELS.pickFilesToUpload (or the literal)`,
    ).toBe(true);
    expect(
      contents.includes("contextBridge.exposeInMainWorld"),
      `preload/index.ts must expose its api via contextBridge.exposeInMainWorld`,
    ).toBe(true);
    // The `datasources` namespace must declare a `pickFilesToUpload:` member.
    expect(
      /\bdatasources\s*:\s*\{[\s\S]*?\bpickFilesToUpload\s*:/.test(contents),
      `preload/index.ts must expose pickFilesToUpload on the datasources namespace`,
    ).toBe(true);
  });

  it("(4) at least one renderer file calls .pickFilesToUpload(", () => {
    const rendererRoot = path.join(repoRoot, "apps/desktop/src/renderer");
    expect(existsSync(rendererRoot)).toBe(true);

    const matches: string[] = [];
    walk(rendererRoot, (filePath) => {
      if (!/\.(ts|tsx)$/.test(filePath)) return;
      if (filePath.split(path.sep).includes("__tests__")) return;
      const contents = readFileSync(filePath, "utf8");
      if (/\.pickFilesToUpload\s*\(/.test(contents)) matches.push(filePath);
    });

    expect(
      matches.length > 0,
      `expected at least one non-test renderer file under apps/desktop/src/renderer/ to call .pickFilesToUpload( — found none`,
    ).toBe(true);
  });
});

function walk(root: string, visit: (filePath: string) => void): void {
  const entries = readdirSync(root);
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(fullPath, visit);
    } else if (stat.isFile()) {
      visit(fullPath);
    }
  }
}
