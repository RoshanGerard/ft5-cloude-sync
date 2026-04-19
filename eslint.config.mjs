// Flat config (ESM). File is .mjs because the root package.json is CommonJS
// (no "type": "module") — renaming to .mjs is the minimal change to opt this
// single file into ESM without flipping the whole workspace.
//
// We use eslint-plugin-import-x (not eslint-plugin-import) because it is the
// maintained, flat-config-first fork and its peerDeps explicitly allow
// ESLint 10. Rule namespace is `import-x/*`.
//
// Type-aware rules (tseslint recommendedTypeChecked + projectService) are
// intentionally deferred: Section 2 has no workspace tsconfig yet, so enabling
// the TypeScript project service would fail on every file it lints. Section 3+
// will introduce package tsconfigs; type-aware rules can be turned on then.
import tseslint from "typescript-eslint";
import importX from "eslint-plugin-import-x";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/.next/**",
      "**/.tsbuild/**",
      "**/release/**",
      "**/coverage/**",
      "pnpm-lock.yaml",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    plugins: {
      "import-x": importX,
    },
    rules: {
      // Forbid intra-repo paths that must not leak into the renderer.
      // `no-restricted-paths` only understands filesystem paths within the
      // repo, so Node core modules and `electron` are handled by
      // `no-restricted-imports` below.
      "import-x/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "apps/desktop/src/renderer",
              from: "apps/desktop/src/main",
              message:
                "Renderer must not import from main. Route through the preload bridge + IPC.",
            },
            {
              target: "apps/desktop/src/renderer",
              from: "apps/desktop/src/preload",
              message:
                "Renderer must not import preload modules directly. Use window.api exposed by contextBridge.",
            },
          ],
        },
      ],
      // Module specifiers `no-restricted-paths` cannot express: Node built-ins
      // (both bare `fs` / `child_process` and `node:*` prefixed) and the
      // `electron` package itself. Renderer runs sandboxed and must have no
      // access to any of these.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "fs",
              message: "Node built-ins are forbidden in the renderer.",
            },
            {
              name: "child_process",
              message: "Node built-ins are forbidden in the renderer.",
            },
            {
              name: "electron",
              message:
                "Renderer must not import electron directly. Use window.api exposed by contextBridge.",
            },
            // Phase 9.2: provider SDKs belong in main-process code (or
            // dedicated services packages), not in the sandboxed renderer.
            // They carry large transitive graphs, many need Node built-ins
            // the renderer does not have, and they break the preload bridge
            // contract. Complement guardrail:
            // scripts/provider-sdk-forbidden-import.test.ts.
            {
              name: "googleapis",
              message:
                "Provider SDKs are forbidden in the renderer. Route through main via window.api.",
            },
            {
              name: "@microsoft/microsoft-graph-client",
              message:
                "Provider SDKs are forbidden in the renderer. Route through main via window.api.",
            },
            {
              name: "@aws-sdk/client-s3",
              message:
                "Provider SDKs are forbidden in the renderer. Route through main via window.api.",
            },
          ],
          patterns: [
            {
              group: ["node:*"],
              message: "Node built-ins (node:*) are forbidden in the renderer.",
            },
            // Any AWS SDK subpackage is forbidden, not just client-s3. The
            // AWS JS SDK v3 is split into ~200 subpackages; listing them
            // individually in the `paths` array would be fragile.
            {
              group: ["@aws-sdk/*"],
              message:
                "Provider SDKs are forbidden in the renderer. Route through main via window.api.",
            },
          ],
        },
      ],
    },
  },
  // Test files under the renderer's `__tests__` dirs are compile-excluded
  // from the renderer's tsconfig and run in Node (via Vitest), never bundled
  // into the browser. They may read repo sources (e.g. globals.css for token-
  // parity assertions) through `node:fs`.
  {
    files: ["apps/desktop/src/renderer/src/**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
