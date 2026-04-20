// Phase 9e — architectural guardrail. The IPC handler layer MUST NOT
// import provider SDKs directly. Any provider-specific knowledge lives
// inside `@ft5/fs-datasource-engine` strategies (`S3Client`,
// `OneDriveClient`, `GoogleDriveClient`); handlers talk to the engine
// through the `ClientFactory` / `DatasourceClient` surface only.
//
// This test walks every `.ts` / `.tsx` file under `apps/desktop/src/main/
// ipc/` and fails if any file imports one of the three provider SDKs via
// either a static `import ... from "<sdk>"` or a dynamic `import("<sdk>")`
// expression. Test files under `__tests__/` are included — the invariant
// is about the handler layer, but test helpers are also not a legitimate
// place to reach for SDKs directly.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const FORBIDDEN_SPECIFIERS = [
  "googleapis",
  "@microsoft/microsoft-graph-client",
  "@aws-sdk/client-s3",
] as const;

function escapeRegex(spec: string): string {
  return spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(spec: string): RegExp {
  const escaped = escapeRegex(spec);
  // Match both static imports (`from "<spec>"`, `from '<spec>'`) and
  // dynamic imports (`import("<spec>")`). Allow whitespace variations.
  return new RegExp(
    `(from\\s*["']${escaped}["'])|(import\\s*\\(\\s*["']${escaped}["']\\s*\\))`,
  );
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        out.push(full);
      }
    }
  }
}

const ipcRoot = path.resolve(__dirname, "..");

describe("no-provider-sdk-imports guardrail", () => {
  it("lists at least a handful of files so we know the walker is wired", () => {
    const files: string[] = [];
    walk(ipcRoot, files);
    expect(files.length).toBeGreaterThan(3);
  });

  it("no file under apps/desktop/src/main/ipc imports googleapis / microsoft-graph-client / @aws-sdk/client-s3", () => {
    const files: string[] = [];
    walk(ipcRoot, files);

    const offenders: { file: string; specifier: string }[] = [];
    for (const file of files) {
      // Skip this very test file — it necessarily contains the forbidden
      // specifiers as string literals.
      if (path.basename(file) === "no-provider-sdk-imports.test.ts") continue;
      const source = fs.readFileSync(file, "utf8");
      for (const spec of FORBIDDEN_SPECIFIERS) {
        if (buildPattern(spec).test(source)) {
          offenders.push({ file, specifier: spec });
        }
      }
    }

    expect(
      offenders,
      `Handler layer must not import provider SDKs directly; offenders:\n${offenders
        .map((o) => `  ${o.file} → ${o.specifier}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
