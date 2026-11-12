// Regenerates the README images with headless Chrome (no npm dependency).
//
//   node src/server/main.ts --demo --port=8792 --web-root=dist/pages &
//   CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" BASE_URL=http://127.0.0.1:8792 node scripts/screenshots.ts
//
// Uses a throwaway profile directory so no browser session or login is involved.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env["CHROME_PATH"];
const base = process.env["BASE_URL"] ?? "http://127.0.0.1:8792";
if (!chrome) throw new Error("set CHROME_PATH");

const shots: Array<{ file: string; path: string; w: number; h: number }> = [
  { file: "dashboard-dark.png", path: "/?theme=bento&mode=dark", w: 1440, h: 2600 },
  { file: "dashboard-light.png", path: "/?theme=swiss&mode=light", w: 1440, h: 1180 },
  { file: "drawer.png", path: "/?theme=bento&mode=light#repo=mizcausevic-dev%2Fshipment-exception-command-center", w: 1440, h: 1100 },
  { file: "mobile.png", path: "/?theme=parchment&mode=light", w: 390, h: 1500 },
  ...["bento", "cosmic", "swiss", "aqua", "brutalist", "tactical", "parchment"].flatMap((t) => [
    { file: `theme-${t}-light.png`, path: `/?theme=${t}&mode=light`, w: 1280, h: 800 },
    { file: `theme-${t}-dark.png`, path: `/?theme=${t}&mode=dark`, w: 1280, h: 800 },
  ]),
];

const profile = mkdtempSync(join(tmpdir(), "gcc-shots-"));
try {
  for (const s of shots) {
    await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--disable-extensions",
      `--user-data-dir=${profile}`,
      "--force-device-scale-factor=1",
      `--window-size=${s.w},${s.h}`,
      "--virtual-time-budget=8000",
      `--screenshot=${resolve(root, "docs/img", s.file)}`,
      base + s.path,
    ]);
    console.log("wrote", s.file);
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}

// Theme gallery: 8 tiles (all 7 themes, mixed light/dark) in a 4x2 grid via ffmpeg.
const tiles = ["bento-dark", "cosmic-dark", "swiss-light", "aqua-light", "brutalist-light", "tactical-dark", "parchment-light", "aqua-dark"];
const img = (f: string) => resolve(root, "docs/img", f);
const scaled = tiles.map((_, i) => `[${i}]scale=640:400[t${i}]`).join(";");
const layout = "0_0|w0_0|w0+w1_0|w0+w1+w2_0|0_h0|w0_h0|w0+w1_h0|w0+w1+w2_h0";
await run(process.env["FFMPEG_PATH"] ?? "ffmpeg", [
  "-loglevel", "error", "-y",
  ...tiles.flatMap((t) => ["-i", img(`theme-${t}.png`)]),
  "-filter_complex", `${scaled};${tiles.map((_, i) => `[t${i}]`).join("")}xstack=inputs=8:layout=${layout}`,
  "-q:v", "3", img("themes.jpg"),
]);
for (const s of shots) if (s.file.startsWith("theme-")) rmSync(img(s.file), { force: true });
console.log("wrote themes.jpg");
