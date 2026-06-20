// Standing regression guard for the error-tag const-reference convention
// (see openspec/specs/fs-datasource-engine/spec.md + fs-sync-service/spec.md:
// "values are referenced via the const object, not raw string literals").
//
// Every `DatasourceErrorTag` / `FilesErrorTag` value MUST be referenced
// through the const object exported from `@ft5/ipc-contracts`
// (`DatasourceErrorTag.AuthRevoked`, `FilesErrorTag.Disconnected`, …) — never
// as a raw string literal — in any error-tag context: construction (`tag:`),
// comparison (`tag === …` / `!==`), or `switch`/`case` arm.
//
// This test scans every `.ts`/`.tsx` source + test file and fails on any
// raw-literal reference outside the documented exemptions. It is RED while
// the migration is in flight and GREEN once the sweep completes; it then
// stays in the suite as the permanent regression guard.

import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// From packages/ipc-contracts/src/__tests__/ walk up to the repo root.
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");

// Roots that carry TypeScript we own.
const SCAN_ROOTS = ["packages", "services", "apps", "scripts"];

// Directories never scanned.
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  ".next",
  "coverage",
  ".worktrees",
  ".git",
  ".turbo",
]);

// Files exempt because they legitimately contain the literals:
// - the two const-object definitions (the source of truth);
// - this guard test (the patterns embed the literals).
const EXEMPT_FILES = new Set(
  [
    "packages/ipc-contracts/src/files.ts",
    "packages/ipc-contracts/src/fs-datasource-engine.ts",
    "packages/ipc-contracts/src/__tests__/error-tag-const-convention.test.ts",
  ].map((p) => p.replaceAll("/", path.sep)),
);

// Intentional protocol/wire literals kept as raw strings (serialized JSON,
// MSW handler bodies, recorded provider responses). Each entry is
// `<repo-relative posix path>|||<trimmed source line>`; an entry stops
// matching if the line text changes, forcing a re-review. Populated during
// the per-package sweep as genuine wire-payload literals are found.
const WIRE_LITERAL_ALLOWLIST = new Set<string>([
  // Deliberate literal-form back-compat assertion: this test exists to prove
  // the pre-refactor raw-literal form still type-checks (the derived type IS
  // the string union). Migrating it would defeat the test's purpose.
  'packages/ipc-contracts/src/__tests__/datasource-error-tag.test-d.ts|||tag: "auth-revoked",',
  // Deliberate OFF-TAXONOMY tag on a DatasourceError: "other" is NOT a
  // DatasourceErrorTag member (the const has no `Other`); this test feeds an
  // arbitrary tag to verify the base re-throws a strategy's tag unchanged.
  // Type-invalid but engine test files are excluded from `tsc -b`. Nothing
  // to migrate to.
  'packages/fs-datasource-engine/src/base-client.test.ts|||tag: "other",',
  // ServiceErrorTag vocabulary (SyncCommandError / sync `ErrorShape`), which
  // is a plain type union with no const object — out of scope, stays literal.
  // `not-found` here is the SERVICE not-found, NOT DatasourceErrorTag.NotFound.
  'services/fs-sync/src/commands/handlers.ts|||tag: "not-found",',
  'services/fs-sync/src/commands/handlers.ts|||error: { tag: "not-found", message: `no job with id ${params.jobId}` },',
  'services/fs-sync/src/ipc/server.test.ts|||error: { tag: "not-found", message: "no" },',
  // `case "other"` is a `DatasourceMimeFamily` switch arm (image/video/.../
  // other), NOT an error tag — a guard false-positive on the shared word
  // "other". Different enum entirely; stays literal.
  'services/fs-sync/src/commands/files-entry-mapping.ts|||case "other":',
  // AuthFailedTag vocabulary: the loopback OAuth broker emits `auth-failed`
  // events whose `tag` is AuthFailedTag (a no-const type union), not
  // Datasource/Files. Out of scope; stays literal.
  'services/fs-sync/src/oauth/loopback-broker.ts|||tag: "auth-revoked",',
  'services/fs-sync/src/oauth/loopback-broker.ts|||tag: "provider-error",',
  // ServiceErrorTag `not-found` on the desktop sync-command surface
  // (SyncCommandError) — same out-of-scope vocabulary, stays literal.
  'apps/desktop/src/main/ipc/sync/__tests__/cancel-job.test.ts|||tag: "not-found",',
  'apps/desktop/src/main/ipc/sync/__tests__/get-job.test.ts|||tag: "not-found",',
  'apps/desktop/src/main/ipc/sync/__tests__/get-retry-policy.test.ts|||tag: "not-found",',
  'apps/desktop/src/main/ipc/sync/get-job.ts|||if (err instanceof SyncCommandError && err.tag === "not-found") {',
  'apps/desktop/src/main/sync/client.request-response.test.ts|||error: { tag: "not-found", message: "no such job" },',
  'apps/desktop/src/main/sync/client.request-response.test.ts|||).rejects.toMatchObject({ tag: "not-found", command: "sync:get-job" });',
  // AuthFailedTag vocabulary (the `auth-failed` event payload) — a plain
  // type union in sync-service/events.ts with no const object, out of
  // scope. Its `auth-revoked` literal shares the string with the two
  // in-scope enums but is a different vocabulary; stays literal.
  'apps/desktop/src/renderer/src/features/datasources/__tests__/store-auth.test.tsx|||tag: "auth-revoked",',
  'apps/desktop/src/renderer/src/features/datasources/__tests__/oauth-form.test.tsx|||tag: "auth-revoked",',
  'apps/desktop/src/renderer/src/features/datasources/__tests__/use-auth-session.test.tsx|||tag: "auth-revoked",',
  // Same AuthFailedTag vocabulary: `AuthSessionState.tag` is `AuthFailedTag`
  // (datasources/store.tsx), so this `auth-revoked` is NOT FilesErrorTag.
  'apps/desktop/src/renderer/src/features/file-explorer/states/__tests__/invalid-datasource.test.tsx|||tag: "auth-revoked",',
  // Deliberate OFF-TAXONOMY fixture: `"network-error"` is NOT a FilesErrorTag
  // member (Files has `disconnected`, not `network-error`), yet this test
  // hands the store a `FilesListResponse` carrying it. Pre-existing fixture;
  // there is no FilesErrorTag.NetworkError to migrate to. Left raw.
  'apps/desktop/src/renderer/src/features/file-explorer/__tests__/store.test.ts|||tag: "network-error",',
  'apps/desktop/src/renderer/src/features/file-explorer/__tests__/store.test.ts|||error: { tag: "network-error" as const, message: "boom", retryable: true },',
]);

// Union of every DatasourceErrorTag + FilesErrorTag value.
const TAG_VALUES = [
  "auth-expired",
  "auth-revoked",
  "not-found",
  "conflict",
  "unsupported",
  "rate-limited",
  "network-error",
  "provider-error",
  "cancelled",
  "invalid-datasource",
  "disconnected",
  "other",
  "exhausted-retries",
];

const VAL = `(?:${TAG_VALUES.join("|")})`;

// Type-position declarations are contract DEFINITIONS, not value
// references — peers of the const objects themselves (interface members
// like `readonly tag: "not-found"` and inline payload unions like
// `readonly tag: "auth-revoked" | "disconnected" | …`). They are exempt,
// and so are string-literal unions of tag values (`"a" | "b"`), which only
// occur in type position. `readonly` is type-only syntax, so it never
// hides a runtime value; a single-pipe union next to a tag literal is
// likewise never a runtime construction (`||` logical-or is unaffected —
// it has no adjacent string literal on the pipe).
const TYPE_DECL = /\breadonly\s+(?:tag|errorTag)\s*:/;
const TAG_UNION = new RegExp(`"${VAL}"\\s*\\|\\s*"|"\\s*\\|\\s*"${VAL}"`);
// An object-TYPE member uses a `;` separator (`{ tag: "other"; message:
// string }`) where a value object uses `,`. A tag literal immediately
// followed by `;` is therefore a type-position member even without
// `readonly` — also a definition, not a value reference.
const TYPE_MEMBER = new RegExp(`(?:tag|errorTag)\\s*:\\s*"${VAL}"\\s*;`);

// Error-tag contexts, evaluated on a comment-stripped line:
// - construction `tag: "…"` (the leading [^"\w] guard skips JSON `"tag":`);
// - comparison `tag === "…"` / `!==` / `==` (either order);
// - `case "…":` switch arm.
const PATTERNS: RegExp[] = [
  new RegExp(`(^|[^"\\w])(?:tag|errorTag)\\s*:\\s*"${VAL}"`),
  new RegExp(`(?:tag|errorTag)\\s*(?:===|!==|==)\\s*"${VAL}"`),
  new RegExp(`"${VAL}"\\s*(?:===|!==|==)\\s*(?:[\\w.]*\\.)?(?:tag|errorTag)\\b`),
  new RegExp(`\\bcase\\s+"${VAL}"\\s*:`),
];

function collectFiles(dir: string, acc: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
}

// Blank out block comments while preserving newlines so line numbers hold.
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

// Strip a line comment, but not the `//` inside `https://` style strings.
function stripLineComment(line: string): string {
  return line.replace(/(^|[^:])\/\/.*$/, "$1");
}

function findViolations(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    collectFiles(path.join(repoRoot, root), files);
  }

  const violations: string[] = [];
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    if (EXEMPT_FILES.has(rel)) continue;

    const lines = stripBlockComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((rawLine, idx) => {
      const line = stripLineComment(rawLine);
      if (!PATTERNS.some((re) => re.test(line))) return;
      // Skip contract type-position declarations (definitions, not refs).
      if (TYPE_DECL.test(line) || TAG_UNION.test(line) || TYPE_MEMBER.test(line))
        return;
      const relPosix = rel.replaceAll(path.sep, "/");
      const key = `${relPosix}|||${rawLine.trim()}`;
      if (WIRE_LITERAL_ALLOWLIST.has(key)) return;
      violations.push(`${relPosix}:${idx + 1}: ${rawLine.trim()}`);
    });
  }
  return violations.sort();
}

describe("error-tag const-reference convention", () => {
  it("no raw DatasourceErrorTag / FilesErrorTag literals outside exemptions", () => {
    const violations = findViolations();
    // Surface the full list on failure so the sweep can be driven to green.
    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });
});
