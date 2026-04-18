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
    plugins: [externalizeDepsPlugin()],
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
    plugins: [externalizeDepsPlugin()],
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
