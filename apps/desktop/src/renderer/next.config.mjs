/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  images: { unoptimized: true },
  basePath: "",
  // Emits to apps/desktop/src/renderer/out.
  //
  // The `@ft5/ipc-contracts` workspace package ships raw TS (no compiled
  // output) with `main: "src/index.ts"`. Its internal re-exports use the
  // NodeNext-style `.js` extension (e.g. `export … from "./datasources.js"`)
  // because the rest of the monorepo (main, preload, services) consumes the
  // package through `tsc` with `moduleResolution: NodeNext`. Next's
  // Turbopack bundler treats those `.js` specifiers as literal file paths
  // and fails when only the `.ts` source exists. Listing the package under
  // `transpilePackages` tells Next to re-run its own loader on the
  // workspace TS, which handles the `.js` → `.ts` rewrite just like it does
  // for files inside the renderer app itself.
  transpilePackages: ["@ft5/ipc-contracts"],
};
export default config;
