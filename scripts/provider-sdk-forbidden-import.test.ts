// Standing guardrail: provider SDKs MUST NOT be imported from the renderer.
// They carry large transitive graphs (AWS signer chains, Google auth clients,
// MS Graph fluent API, etc.) and in most cases require Node built-ins that
// the sandboxed renderer does not have. Provider access always goes through
// the main process via the preload IPC bridge.
//
// Forbidden specifiers:
//   - `googleapis`
//   - `@microsoft/microsoft-graph-client`
//   - `@aws-sdk/client-s3`          (named in task 9.2)
//   - `@aws-sdk/*`                  (natural extension — any AWS SDK subpkg)
//
// Scope: `.ts` and `.tsx` files under
//   - apps/desktop/src/renderer/src/features/**
//   - apps/desktop/src/renderer/src/components/**
//   - apps/desktop/src/renderer/src/app/**
//   - apps/desktop/src/renderer/src/lib/**
//   - apps/desktop/src/renderer/src/styles/**
//   - apps/desktop/src/renderer/src/types/**
// Exempt:
//   - any `__tests__/` directory (test-only imports are not bundled, but none
//     currently exist and this keeps the guardrail focused on production code)
//
// Covers task 9.2 of the `ui-ux-design` OpenSpec change. This guardrail is a
// complement to the `no-restricted-imports` rule added to `eslint.config.mjs`
// in the same task — ESLint catches it during `pnpm lint`, this catches it
// independently under `pnpm test` so a bypassed ESLint config can't slip it
// past CI.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const RENDERER_SRC = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src",
  "renderer",
  "src",
);

const SCAN_ROOTS = [
  path.join(RENDERER_SRC, "features"),
  path.join(RENDERER_SRC, "components"),
  path.join(RENDERER_SRC, "app"),
  path.join(RENDERER_SRC, "lib"),
  path.join(RENDERER_SRC, "styles"),
  path.join(RENDERER_SRC, "types"),
];

// Matches, at the start of a line (under the /m flag):
//   import <anything-without-quotes> from "<specifier>"
//   import "<specifier>"
// and their single-quoted twins. We support both exact specifiers (googleapis,
// @microsoft/microsoft-graph-client) and scoped-package prefixes (@aws-sdk/*)
// via the `scopedPrefix` flag. Line-anchored so mentions inside comments or
// JSX string props can't trigger false positives.
type ForbiddenSpec =
  | { kind: "exact"; specifier: string }
  | { kind: "prefix"; prefix: string };

const FORBIDDEN: ForbiddenSpec[] = [
  { kind: "exact", specifier: "googleapis" },
  { kind: "exact", specifier: "@microsoft/microsoft-graph-client" },
  { kind: "prefix", prefix: "@aws-sdk/" },
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildImportRegex(spec: ForbiddenSpec): RegExp {
  // Specifier pattern — either a literal string or a prefix followed by at
  // least one additional character (so `@aws-sdk/` alone without a subpath
  // is still caught — `@aws-sdk/` resolves to `@aws-sdk/index.js` which is
  // meaningless but the guardrail shouldn't be lenient about near-misses).
  const specPattern =
    spec.kind === "exact"
      ? escapeRegex(spec.specifier)
      : `${escapeRegex(spec.prefix)}[^"'\\s]+`;
  // `from "<spec>"` (with or without a side-effect-only form).
  return new RegExp(
    `^(?:import\\s+[^'"]+from\\s+["']${specPattern}["']|import\\s+["']${specPattern}["'])`,
    "gm",
  );
}

type Violation = {
  file: string;
  line: number;
  column: number;
  match: string;
  specifier: string;
};

function findViolationsInText(text: string, file: string): Violation[] {
  const violations: Violation[] = [];
  for (const spec of FORBIDDEN) {
    const re = buildImportRegex(spec);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const { line, column } = offsetToLineCol(text, m.index);
      violations.push({
        file,
        line,
        column,
        match: m[0],
        specifier: spec.kind === "exact" ? spec.specifier : `${spec.prefix}*`,
      });
    }
  }
  return violations;
}

function offsetToLineCol(
  text: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function walkSource(root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      walkSource(full, out);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        // Skip ambient/declaration files and test utilities.
        if (entry.name.endsWith(".d.ts")) continue;
        out.push(full);
      }
    }
  }
}

describe("provider-sdk forbidden-import guardrail — detection", () => {
  it("flags a named import from googleapis", () => {
    const v = findViolationsInText(
      'import { google } from "googleapis";\n',
      "fake.ts",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.specifier).toBe("googleapis");
    expect(v[0]!.line).toBe(1);
    expect(v[0]!.column).toBe(1);
  });

  it("flags a default import from @microsoft/microsoft-graph-client", () => {
    const v = findViolationsInText(
      'import Client from "@microsoft/microsoft-graph-client";\n',
      "fake.ts",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.specifier).toBe("@microsoft/microsoft-graph-client");
  });

  it("flags a named import from @aws-sdk/client-s3", () => {
    const v = findViolationsInText(
      'import { S3Client } from "@aws-sdk/client-s3";\n',
      "fake.ts",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.specifier).toBe("@aws-sdk/*");
  });

  it("flags any other @aws-sdk subpackage via the prefix rule", () => {
    const v = findViolationsInText(
      'import { fromIni } from "@aws-sdk/credential-provider-node";\n',
      "fake.ts",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.specifier).toBe("@aws-sdk/*");
  });

  it("flags a side-effect import from a forbidden package", () => {
    const v = findViolationsInText('import "googleapis";\n', "fake.ts");
    expect(v.length).toBe(1);
    expect(v[0]!.specifier).toBe("googleapis");
  });

  it("flags a single-quoted import specifier", () => {
    const v = findViolationsInText(
      "import { S3Client } from '@aws-sdk/client-s3';\n",
      "fake.ts",
    );
    expect(v.length).toBe(1);
    expect(v[0]!.specifier).toBe("@aws-sdk/*");
  });

  it("does NOT flag a near-miss like googleapis-common (different specifier)", () => {
    const v = findViolationsInText(
      'import { x } from "googleapis-common";\n',
      "fake.ts",
    );
    expect(v).toEqual([]);
  });

  it("does NOT flag a near-miss like @microsoft/microsoft-graph (suffix differs)", () => {
    const v = findViolationsInText(
      'import { x } from "@microsoft/microsoft-graph";\n',
      "fake.ts",
    );
    expect(v).toEqual([]);
  });

  it("does NOT flag @aws-sdk as a bare package name (no subpath after the slash)", () => {
    // `@aws-sdk` with no slash is not a real package but should not match
    // the `@aws-sdk/` prefix rule either.
    const v = findViolationsInText(
      'import { x } from "@aws-sdk";\n',
      "fake.ts",
    );
    expect(v).toEqual([]);
  });

  it("does NOT flag mentions of forbidden package names inside comments", () => {
    const v = findViolationsInText(
      '// TODO: integrate with googleapis and @aws-sdk/client-s3\nconst x = 1;\n',
      "fake.ts",
    );
    expect(v).toEqual([]);
  });

  it("reports accurate line and column for an import on line 3", () => {
    const text =
      'const a = 1;\nconst b = 2;\nimport { google } from "googleapis";\n';
    const v = findViolationsInText(text, "x.ts");
    expect(v.length).toBe(1);
    expect(v[0]!.line).toBe(3);
    expect(v[0]!.column).toBe(1);
  });
});

describe("provider-sdk forbidden-import guardrail — renderer code is clean", () => {
  it("no renderer source file imports a forbidden provider SDK", () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      walkSource(root, files);
    }
    expect(
      files.length,
      "expected at least one renderer source file to scan",
    ).toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const file of files) {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      const text = readFileSync(file, "utf8");
      violations.push(...findViolationsInText(text, file));
    }

    expect(
      violations,
      violations.length
        ? `Renderer must not import provider SDKs directly. Route through main via the preload IPC bridge.\n${violations
            .map(
              (v) =>
                `  ${v.file}:${v.line}:${v.column}  [${v.specifier}]  ${v.match}`,
            )
            .join("\n")}`
        : "",
    ).toEqual([]);
  });
});
