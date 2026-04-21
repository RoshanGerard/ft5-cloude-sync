// Standing regression test for the drizzle-orm boundary grep guard in
// .github/workflows/ci.yml (the `drizzle-boundary` job). Mirrors the exact
// grep pipeline the CI workflow runs so the guarantee is testable locally.
//
// RED-then-GREEN (task 1.5):
//   RED  — the "ok" fixture under services/fs-sync/src/db/ is flagged by the
//          old allowlist (only apps/desktop/src/main/), so assertion (a) fails.
//   GREEN — ci.yml allowlist is extended to also permit services/fs-sync/src/db/
//           and services/fs-sync/src/main/, and the grep below is updated to
//           match; both assertions pass.
//
// See scripts/lint-forbidden-import.test.ts for the fixture+execSync pattern.
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  rmdirSync,
} from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

// Fixture paths — must remain relative to repoRoot so the grep output paths
// are predictable.  Both live under services/fs-sync/src/ so they exercise
// the service-specific allowlist extension.
const badFixtureDir = path.join(
  repoRoot,
  "services",
  "fs-sync",
  "src",
  "scheduler",
  "__drizzle_regression__",
);
const badFixturePath = path.join(badFixtureDir, "bad.ts");

const okFixtureDir = path.join(
  repoRoot,
  "services",
  "fs-sync",
  "src",
  "db",
  "__drizzle_regression__",
);
const okFixturePath = path.join(okFixtureDir, "ok.ts");

const DRIZZLE_IMPORT_LINE = `import { eq } from "drizzle-orm";\nexport const unused = eq;\n`;

afterEach(() => {
  for (const [file, dir] of [
    [badFixturePath, badFixtureDir],
    [okFixturePath, okFixtureDir],
  ] as [string, string][]) {
    if (existsSync(file)) unlinkSync(file);
    if (existsSync(dir)) rmdirSync(dir);
  }
});

/**
 * Run the same grep pipeline the CI drizzle-boundary job uses.
 * Returns the stdout string (all matching lines that survive the allowlist
 * filter). An empty string means no violations were found.
 *
 * IMPORTANT: must pass { shell: 'bash' } because the command is a shell
 * pipeline with pipes, `||`, and POSIX-style grep flags that do not execute
 * under cmd.exe on Windows.
 *
 * This command MUST stay in sync with the grep in
 * .github/workflows/ci.yml (drizzle-boundary job).
 */
function runDrizzleBoundaryGrep(): string {
  // Pass the full pipeline as a single argv to `bash -c` so Node doesn't
  // need to escape the double-quotes that appear in grep's regex.
  const script =
    String.raw`grep -rInE "from ['\"]drizzle-orm|require\(['\"]drizzle-orm" ` +
    `--include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' ` +
    `--include='*.mjs' --include='*.cjs' --include='*.js' --include='*.jsx' ` +
    `--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=out ` +
    `--exclude-dir=.next --exclude-dir=release ` +
    `. ` +
    `| grep -v '^\./apps/desktop/src/main/' ` +
    `| grep -v '^\./services/fs-sync/src/db/' ` +
    `| grep -v '^\./services/fs-sync/src/main/' ` +
    `|| true`;
  const res = spawnSync("bash", ["-c", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return (res.stdout ?? "").trim();
}

describe("drizzle-orm boundary check (mirrors CI drizzle-boundary job)", () => {
  it(
    "flags a drizzle import outside the allowed service subpaths (bad fixture under scheduler/)",
    () => {
      mkdirSync(badFixtureDir, { recursive: true });
      writeFileSync(badFixturePath, DRIZZLE_IMPORT_LINE);

      const output = runDrizzleBoundaryGrep();

      // The bad fixture is NOT under an allowed path, so it must appear.
      expect(output).toMatch(
        /services[/\\]fs-sync[/\\]src[/\\]scheduler[/\\]__drizzle_regression__[/\\]bad\.ts/,
      );
    },
    30_000,
  );

  it(
    "does NOT flag a drizzle import under the allowed services/fs-sync/src/db/ subpath",
    () => {
      mkdirSync(okFixtureDir, { recursive: true });
      writeFileSync(okFixturePath, DRIZZLE_IMPORT_LINE);

      const output = runDrizzleBoundaryGrep();

      // The ok fixture IS under the allowed db/ subpath, so it must NOT appear.
      expect(output).not.toMatch(
        /services[/\\]fs-sync[/\\]src[/\\]db[/\\]__drizzle_regression__[/\\]ok\.ts/,
      );
    },
    30_000,
  );

  it("CI workflow keeps the service-scoped allowlist entries", () => {
    // Drift guard: if someone edits .github/workflows/ci.yml without
    // mirroring the allowlist here, this assertion surfaces the gap.
    const ciYamlPath = path.join(repoRoot, ".github", "workflows", "ci.yml");
    const ci = execSync(`cat ${JSON.stringify(ciYamlPath)}`, {
      encoding: "utf8",
      shell: "bash",
    });
    expect(ci).toContain("'^\\./apps/desktop/src/main/'");
    expect(ci).toContain("'^\\./services/fs-sync/src/db/'");
    expect(ci).toContain("'^\\./services/fs-sync/src/main/'");
  });
});
