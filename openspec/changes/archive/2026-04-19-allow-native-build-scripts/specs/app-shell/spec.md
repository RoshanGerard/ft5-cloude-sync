## ADDED Requirements

### Requirement: Native module dependencies are ready after a clean install

After a fresh `pnpm install` on a clean clone — with no prior `pnpm approve-builds` step, no prior `pnpm rebuild`, and no prior `pnpm --filter @ft5/desktop run postinstall` — the workspace SHALL be in a state where:

1. The Electron binary is present and `require('electron')` from a Node process inside the workspace resolves to a real binary path (i.e. Electron's `install.js` script has executed and written `node_modules/.pnpm/electron@<version>/node_modules/electron/path.txt`).
2. Every native addon depended on by the main process (currently `better-sqlite3`) loads under Electron without an ABI-mismatch error (e.g. without `Error: The module '…better_sqlite3.node' was compiled against a different Node.js version`).

This SHALL be achieved by an explicit `pnpm.onlyBuiltDependencies` allowlist in the repository's root `package.json` — not by per-user configuration, not by a README instruction telling contributors to run `pnpm approve-builds` themselves, and not by disabling pnpm's build-script security default globally.

#### Scenario: Fresh clone can load better-sqlite3 under Electron without manual intervention

- **WHEN** a developer clones the repository, runs `pnpm install`, and then runs `pnpm --filter @ft5/desktop exec electron -e "require('better-sqlite3')"`
- **THEN** the Electron process exits with code 0 and prints no error on stderr, with no prior `pnpm approve-builds`, `pnpm rebuild`, or targeted postinstall run

#### Scenario: Allowlist is defined in source, not per-user pnpm configuration

- **WHEN** a reviewer reads `package.json` at the repo root
- **THEN** there is a `pnpm.onlyBuiltDependencies` array that includes, at minimum, every package pnpm 10 flags in its "Ignored build scripts" warning for the current dependency graph — currently `better-sqlite3`, `electron`, `electron-winstaller`, `esbuild`, `sharp`, and `unrs-resolver`

#### Scenario: Allowlist regression is caught by the test suite

- **WHEN** any commit removes the `pnpm` block from root `package.json`, or drops any of the required packages from the `onlyBuiltDependencies` array
- **THEN** `scripts/pnpm-built-deps.test.ts` fails and `pnpm -w test` exits non-zero
