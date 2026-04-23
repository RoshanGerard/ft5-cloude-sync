import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Vitest 3.2.4: `typecheck` is a first-class config key (see `TypecheckConfig`
// in vitest/dist). `typecheck.enabled: true` turns on the dedicated type-level
// test runner alongside regular tests. The default `typecheck.include` pattern
// already matches `**/*.test-d.ts`, but we also add `.test-d.ts` to the normal
// `include` so the runtime `expectTypeOf` + runtime `expect` assertions in
// those files execute as ordinary tests too. Without that, a file that only
// contains type-level assertions would register zero runtime tests.
export default defineConfig({
  // React 19 / Next.js 16 use the automatic JSX runtime, so JSX in renderer
  // .tsx test files does not emit `React.createElement` and never imports
  // `React`. esbuild's Vitest default ("transform") leaves us with classic
  // factory calls that blow up at runtime with "React is not defined". Set
  // JSX to automatic here so Vitest matches the Next.js build.
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      // Mirror the renderer tsconfig `@/*` path alias so renderer tests can
      // import via the same specifiers that production code uses. Scoped to
      // the renderer `src/` directory; main / preload / packages / services
      // never use this alias so the extra entry is inert for them.
      "@": fileURLToPath(new URL("./apps/desktop/src/renderer/src", import.meta.url)),
      // `react` / `react-dom` / `react/jsx-runtime` are only declared in the
      // renderer package's dependencies (they shouldn't bleed into main or
      // preload). The file-explorer render-budget guardrail at
      // `scripts/render-budget.test.tsx` actually renders a React tree in
      // jsdom, so it needs access to the same copies of React the renderer
      // uses. Point the aliases at the renderer's resolved symlinks — this
      // makes the render-budget test self-contained without promoting React
      // to a root devDependency.
      react: fileURLToPath(
        new URL(
          "./apps/desktop/src/renderer/node_modules/react",
          import.meta.url,
        ),
      ),
      "react-dom": fileURLToPath(
        new URL(
          "./apps/desktop/src/renderer/node_modules/react-dom",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: [
      "scripts/**/*.test.{ts,tsx}",
      "packages/**/src/**/*.test.ts",
      "packages/**/src/**/*.test-d.ts",
      "apps/**/src/**/*.test.{ts,tsx}",
      "apps/**/src/**/*.test-d.ts",
      "services/**/src/**/*.test.ts",
    ],
    typecheck: {
      enabled: true,
      include: [
        "packages/**/src/**/*.test-d.ts",
        "apps/**/src/**/*.test-d.ts",
      ],
    },
  },
});
