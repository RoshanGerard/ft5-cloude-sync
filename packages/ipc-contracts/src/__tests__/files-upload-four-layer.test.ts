// Task 8.1 — `files.upload` four-layer wiring guardrail.
//
// Asserts the channel introduced by `add-file-explorer-drag-drop-upload`
// is wired end-to-end:
//   (1) Contract:        `packages/ipc-contracts/src/files.ts` declares the
//                        `"files:upload"` literal AND exports
//                        `FilesUploadRequest` + `FilesUploadResponse`.
//   (2) Handler:         `apps/desktop/src/main/ipc/files/upload.ts` exists.
//   (3) Preload binding: `apps/desktop/src/preload/index.ts` references
//                        `FILES_CHANNELS.upload` (or the literal) AND exposes
//                        `upload` on the `files` namespace via contextBridge.
//   (4) Renderer call:   at least one file under `apps/desktop/src/renderer/`
//                        (excluding `__tests__/`) destructures
//                        `window.api.files` and calls `.upload(` on it.
//
// Sibling tests live alongside this one for `datasources.pickFilesToUpload`
// (8.2) and to assert the retired `datasources.upload` channel is gone (8.3).

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
// `packages/ipc-contracts/src/__tests__/<file>.ts` → repo root is four levels up.
const repoRoot = path.resolve(__dirname, "../../../..");

describe("files.upload four-layer wiring", () => {
  it("repo-root resolution sanity check (package.json exists at repoRoot)", () => {
    expect(existsSync(path.join(repoRoot, "package.json"))).toBe(true);
  });

  it("(1) contract declares the channel literal AND exports the types", () => {
    const contractPath = path.join(
      repoRoot,
      "packages/ipc-contracts/src/files.ts",
    );
    const contents = readFileSync(contractPath, "utf8");
    expect(
      contents.includes(`"files:upload"`),
      `files.ts must declare the channel literal "files:upload"`,
    ).toBe(true);
    expect(
      /export\s+(?:interface|type)\s+FilesUploadRequest\b/.test(contents),
      `files.ts must export type FilesUploadRequest`,
    ).toBe(true);
    expect(
      /export\s+(?:interface|type)\s+FilesUploadResponse\b/.test(contents),
      `files.ts must export type FilesUploadResponse`,
    ).toBe(true);
  });

  it("(2) handler file exists at apps/desktop/src/main/ipc/files/upload.ts", () => {
    const handlerPath = path.join(
      repoRoot,
      "apps/desktop/src/main/ipc/files/upload.ts",
    );
    expect(
      existsSync(handlerPath),
      `expected handler file at ${handlerPath}`,
    ).toBe(true);
  });

  it("(3) preload references the channel and exposes upload on the files namespace", () => {
    const preloadPath = path.join(
      repoRoot,
      "apps/desktop/src/preload/index.ts",
    );
    const contents = readFileSync(preloadPath, "utf8");
    expect(
      contents.includes("FILES_CHANNELS.upload") ||
        contents.includes(`"files:upload"`),
      `preload/index.ts must reference FILES_CHANNELS.upload (or the literal)`,
    ).toBe(true);
    // Confirm the preload exposes the bridge to the renderer at all — without
    // contextBridge, the renderer-side `window.api.files.upload` test below
    // would assert nothing useful.
    expect(
      contents.includes("contextBridge.exposeInMainWorld"),
      `preload/index.ts must expose its api via contextBridge.exposeInMainWorld`,
    ).toBe(true);
    // The `files` namespace must declare an `upload:` member. Tolerate
    // arbitrary whitespace / newlines between `files:` and `upload:` because
    // the namespace is an object literal that may be reformatted.
    expect(
      /\bfiles\s*:\s*\{[\s\S]*?\bupload\s*:/.test(contents),
      `preload/index.ts must expose upload on the files namespace`,
    ).toBe(true);
  });

  it("(4) at least one renderer file destructures window.api.files and calls .upload(", () => {
    const rendererRoot = path.join(repoRoot, "apps/desktop/src/renderer");
    expect(existsSync(rendererRoot)).toBe(true);

    const matches: string[] = [];
    walk(rendererRoot, (filePath) => {
      if (!/\.(ts|tsx)$/.test(filePath)) return;
      // Skip test directories — call sites under tests don't count.
      if (filePath.split(path.sep).includes("__tests__")) return;
      const contents = readFileSync(filePath, "utf8");
      const referencesFiles =
        /window\.api\.files\b/.test(contents) ||
        /window\?\.api\?\.files\b/.test(contents) ||
        /\bapi\.files\b/.test(contents);
      const callsUpload = /\.upload\s*\(/.test(contents);
      if (referencesFiles && callsUpload) matches.push(filePath);
    });

    expect(
      matches.length > 0,
      `expected at least one non-test renderer file under apps/desktop/src/renderer/ to reference window.api.files (or api.files) AND call .upload( — found none`,
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
