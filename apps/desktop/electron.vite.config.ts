import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

// Main and preload compile through Vite/Rollup into CJS modules under
// `dist/main` and `dist/preload`. The renderer is intentionally omitted
// from this config: Next.js 16 emits a fully static bundle to
// `src/renderer/out/` via `next build`, and electron-builder picks it up
// through `extraResources` in `electron-builder.yml`. Bundling the renderer
// through electron-vite would duplicate work and fight the Next toolchain.
export default defineConfig({
  main: {
    plugins: [
      // Externalize runtime deps EXCEPT the engine and its provider SDK
      // chain. The engine pulls in `@aws-sdk/*` (which transitively pulls
      // ~50 `@smithy/*` packages) and `googleapis` — pnpm's content-
      // addressable store keeps these under `<repo>/node_modules/.pnpm/`,
      // OUTSIDE this workspace's `node_modules/`. electron-builder's
      // file walker only sees the desktop workspace tree, so externalized
      // requires fail at packaged runtime with `Cannot find module
      // '@smithy/util-buffer-from'` (and similar). Bundling the engine
      // pulls all transitives into `dist/main/index.js` so there's no
      // runtime resolution to miss. Native modules + electron itself
      // remain externalized — those need to be loaded via host bindings.
      externalizeDepsPlugin({
        exclude: [
          "@ft5/fs-datasource-engine",
        ],
      }),
    ],
    build: {
      outDir: "dist/main",
      lib: {
        entry: resolve(__dirname, "src/main/index.ts"),
        formats: ["cjs"],
        fileName: () => "index.js",
      },
      rollupOptions: {
        output: { format: "cjs" },
      },
    },
  },
  preload: {
    // Exclude `@ft5/ipc-contracts` from externalization so it's bundled
    // into the preload's CJS output. Electron's sandboxed preload context
    // can only resolve "electron" at runtime; any other specifier left as
    // a runtime `require(...)` (the default behavior of
    // externalizeDepsPlugin) will fail with "module not found" inside the
    // sandbox and silently break `window.api` exposure. Regression guard
    // lives at `scripts/preload-bundle.test.ts`.
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@ft5/ipc-contracts",
          "@ft5/ipc-contracts/sync-service-desktop",
        ],
      }),
    ],
    build: {
      outDir: "dist/preload",
      lib: {
        entry: resolve(__dirname, "src/preload/index.ts"),
        formats: ["cjs"],
        fileName: () => "index.js",
      },
      rollupOptions: {
        output: { format: "cjs" },
      },
    },
  },
});
