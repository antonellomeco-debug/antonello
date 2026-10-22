// Chrome senza finestra per i PDF dei report e le copertine dei video: lo stesso che usa HyperFrames.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Chrome da usare: variabile REPORT_BROWSER_PATH, quello di HyperFrames, la copia scaricata da HyperFrames, Chrome del Mac. */
export function findBrowser() {
  const cached = [];
  for (const base of [path.join(os.homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell"), path.join(os.homedir(), ".cache", "puppeteer", "chrome-headless-shell")]) {
    let versions = [];
    try {
      versions = fs.readdirSync(base).sort().reverse();
    } catch {
      continue;
    }
    for (const v of versions) {
      let dirs = [];
      try {
        dirs = fs.readdirSync(path.join(base, v)).filter((d) => d.startsWith("chrome-headless-shell-"));
      } catch {
        continue;
      }
      for (const d of dirs) cached.push(path.join(base, v, d, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell"));
    }
  }
  const candidates = [
    process.env.REPORT_BROWSER_PATH,
    process.env.HYPERFRAMES_BROWSER_PATH,
    ...cached,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}
