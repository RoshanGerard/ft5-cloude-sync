import { defineConfig } from "electron-vite";

// Three-target electron-vite config. Main and preload compile through Vite/
// Rollup and emit into `dist/main` and `dist/preload` respectively (matching
// the `main` field in `package.json` and the preload path referenced from
// `main/index.ts`). The renderer block is intentionally a placeholder for
// Section 4: Next.js 16 static export (added in Section 6) will replace this
// with a delegation to `next build` output. Until then, keep the block minimal
// so `electron-vite build` for main + preload still parses the config without
// attempting to bundle a non-existent renderer entry.
export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      lib: {
        entry: "src/main/index.ts",
      },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      lib: {
        entry: "src/preload/index.ts",
      },
    },
  },
  // TODO(section-6): Replace with a delegation to the Next.js 16 static export
  // output directory. For now, this placeholder keeps the config shape valid.
  renderer: {
    root: "src/renderer",
    build: {
      outDir: "dist/renderer",
    },
  },
});
