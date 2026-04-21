// Standing regression test enforcing "Service consumes the engine only
// through ClientFactory" (base spec). No file under services/fs-sync/src/
// may import a provider SDK directly — uploads, deletes, and every other
// remote-facing call go through DatasourceClient<T>.

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// From services/fs-sync/src/executors/ walk up to the repo root.
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const serviceSrc = path.resolve(__dirname, "..");

const FORBIDDEN = [
  "@aws-sdk/client-s3",
  "@aws-sdk/lib-storage",
  "googleapis",
  "@microsoft/microsoft-graph-client",
];

function runGrep(specifier: string): string[] {
  const pattern = `from ['\\"]${specifier}['\\"]`;
  const res = spawnSync(
    "bash",
    [
      "-c",
      `grep -rInE "${pattern}" --include='*.ts' ${JSON.stringify(serviceSrc)} || true`,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return (res.stdout ?? "")
    .split("\n")
    .filter((l) => l.length > 0)
    // The test file itself lists the specifiers in string literals — skip.
    .filter((l) => !l.includes("no-sdk-imports.test.ts"));
}

describe("fs-sync service — no provider SDK imports", () => {
  it.each(FORBIDDEN)("no file imports from %s", (specifier) => {
    const hits = runGrep(specifier);
    expect(hits).toEqual([]);
  });
});
