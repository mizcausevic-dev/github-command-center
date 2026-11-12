// Builds two dashboard bundles from the same source:
//   dist/web    served by the Node API server; talks HTTP to /api/v1
//   dist/pages  static GitHub Pages demo; runs the API in the browser over demo/snapshot.json
// Output is an explicit allow-list of files; nothing else from the repo is copied.

import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = ["index.html", "theme-boot.js", "favicon.svg"];

async function bundle(outdir: string, inBrowserApi: boolean): Promise<void> {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  await build({
    entryPoints: { app: resolve(root, "web/src/main.ts"), styles: resolve(root, "web/src/styles.css") },
    outdir,
    bundle: true,
    format: "esm",
    splitting: false,
    target: ["es2022"],
    minify: true,
    sourcemap: false,
    legalComments: "none",
    define: { __IN_BROWSER_API__: String(inBrowserApi) },
    logLevel: "warning",
  });
  for (const f of STATIC) copyFileSync(resolve(root, "web", f), resolve(outdir, f));
  if (inBrowserApi) {
    copyFileSync(resolve(root, "demo/snapshot.json"), resolve(outdir, "snapshot.json"));
    const preview = resolve(root, ".github/social-preview.png");
    if (existsSync(preview)) copyFileSync(preview, resolve(outdir, "social-preview.png"));
  }
  console.log(`${outdir.replace(root, ".")}: ${readdirSync(outdir).join(", ")}`);
}

await bundle(resolve(root, "dist/web"), false);
await bundle(resolve(root, "dist/pages"), true);
