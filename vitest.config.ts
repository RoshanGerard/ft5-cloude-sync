import { defineConfig } from "vitest/config";

// Vitest 3.2.4: `typecheck` is a first-class config key (see `TypecheckConfig`
// in vitest/dist). `typecheck.enabled: true` turns on the dedicated type-level
// test runner alongside regular tests. The default `typecheck.include` pattern
// already matches `**/*.test-d.ts`, but we also add `.test-d.ts` to the normal
// `include` so the runtime `expectTypeOf` + runtime `expect` assertions in
// those files execute as ordinary tests too. Without that, a file that only
// contains type-level assertions would register zero runtime tests.
export default defineConfig({
  test: {
    include: [
      "scripts/**/*.test.ts",
      "packages/**/src/**/*.test.ts",
      "packages/**/src/**/*.test-d.ts",
      "apps/**/src/**/*.test.ts",
      "services/**/src/**/*.test.ts",
    ],
    typecheck: {
      enabled: true,
      include: ["packages/**/src/**/*.test-d.ts"],
    },
  },
});
