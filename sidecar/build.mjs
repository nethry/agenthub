// Bundles the sidecar's own sources into dist/main.mjs. The SDKs stay external:
// they locate their native runtimes relative to their own install folder
// (createRequire(import.meta.url)), so they must be resolved from node_modules.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20.19",
  packages: "external",
  sourcemap: false,
  legalComments: "none",
  define: { __SIDECAR_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "info",
});
