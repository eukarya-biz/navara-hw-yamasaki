import { resolve } from "node:path";
import { defineConfig, normalizePath } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// @navaramap/three ships prebuilt WASM and EXR/bin atmosphere textures that it
// loads itself using paths relative to `import.meta.url`. Vite's dev-time
// dependency pre-bundling (esbuild -> node_modules/.vite/deps) cannot see those
// self-referential binary loads, so it does not copy them into the cache. The
// requests then 404 and the dev server answers with the SPA fallback
// (index.html), which the WASM compiler and the EXR loader try to parse as
// binary -- that is the "black screen" failure with
// "expected magic word ... found 3c 21 64 6f" (`<!do`).
//
// Two fixes, both required:
//   1. optimizeDeps.exclude -- serve these packages as real files out of
//      node_modules so `import.meta.url` resolves to their true location.
//   2. viteStaticCopy -- @takram/three-atmosphere reads its textures from the
//      fixed path /assets/atmosphere/..., so put the real files there.
const NAVARA_THREE_DIST = normalizePath(
  resolve(__dirname, "node_modules/@navaramap/three/dist"),
);
const NAVARA_THREE_ASSETS = `${NAVARA_THREE_DIST}/assets`;

export default defineConfig({
  // Relative base, so the built app works from any subpath. GitHub Pages
  // project sites serve from https://<org>.github.io/<repo>/, and with the
  // default base ("/") every built asset URL would point at the domain root
  // and 404. "./" keeps this independent of the repository name.
  base: "./",
  plugins: [
    wasm(),
    topLevelAwait(),
    viteStaticCopy({
      targets: [
        { src: `${NAVARA_THREE_ASSETS}/*`, dest: "." },
        { src: `${NAVARA_THREE_ASSETS}/*`, dest: "assets" },
        { src: `${NAVARA_THREE_DIST}/*.wasm`, dest: "." },
        { src: `${NAVARA_THREE_DIST}/*.wasm`, dest: "assets" },
      ],
    }),
  ],
  optimizeDeps: {
    exclude: [
      "@navaramap/three",
      "@navaramap/three_default_plugin",
      "@navaramap/three_plugins",
      "@navaramap/three_default_descs",
      "@navaramap/engine",
      "@navaramap/engine-api",
      "@navaramap/engine-worker",
      "@navaramap/engine-font-worker",
    ],
  },
  server: {
    fs: { allow: [".."] },
  },
});
