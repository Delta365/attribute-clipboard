// Build script for the Attribute Clipboard Figma plugin.
// - Bundles src/code.ts -> dist/code.js (Figma sandbox / main thread)
// - Bundles src/ui.ts and inlines it into src/ui.html -> dist/ui.html (UI iframe)

import esbuild from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

const watch = process.argv.includes("--watch");

const codeOptions = {
  entryPoints: [path.join(SRC, "code.ts")],
  bundle: true,
  outfile: path.join(DIST, "code.js"),
  platform: "browser",
  target: "es2017",
  format: "iife",
  legalComments: "none",
  logLevel: "info",
};

const uiOptions = {
  entryPoints: [path.join(SRC, "ui.ts")],
  bundle: true,
  write: false,
  platform: "browser",
  target: "es2020",
  format: "iife",
  legalComments: "none",
  logLevel: "info",
  outdir: DIST,
  entryNames: "ui",
};

async function buildHtml() {
  const result = await esbuild.build(uiOptions);
  const jsFile = result.outputFiles.find((f) => f.path.endsWith(".js"));
  const cssFile = result.outputFiles.find((f) => f.path.endsWith(".css"));
  if (!jsFile) throw new Error("esbuild produced no JS output for ui.ts");

  const template = await readFile(path.join(SRC, "ui.html"), "utf8");
  if (!template.includes("<!--SCRIPT-->")) {
    throw new Error("src/ui.html is missing the <!--SCRIPT--> placeholder");
  }
  if (!template.includes("<!--STYLES-->")) {
    throw new Error("src/ui.html is missing the <!--STYLES--> placeholder");
  }

  const styleTag = cssFile ? `<style>${cssFile.text}</style>` : "";
  let html = template.replace("<!--STYLES-->", () => styleTag);
  html = html.replace("<!--SCRIPT-->", () => `<script>${jsFile.text}</script>`);

  await writeFile(path.join(DIST, "ui.html"), html);

  const jsKb = (jsFile.text.length / 1024).toFixed(1);
  const cssKb = cssFile ? (cssFile.text.length / 1024).toFixed(1) : "0";
  console.log(`[build] ui.html (js: ${jsKb} kB, css: ${cssKb} kB)`);
}

async function buildAll() {
  if (!existsSync(DIST)) await mkdir(DIST, { recursive: true });
  await esbuild.build(codeOptions);
  await buildHtml();
  console.log("[build] dist/code.js + dist/ui.html");
}

if (watch) {
  await buildAll();
  const ctx = await esbuild.context({
    ...codeOptions,
    plugins: [
      {
        name: "log-rebuild",
        setup(b) {
          b.onEnd(() => console.log("[watch] rebuilt code.js"));
        },
      },
    ],
  });
  await ctx.watch();

  const { watch: fsWatch } = await import("node:fs");
  let pending = false;
  const trigger = () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => {
      pending = false;
      try {
        await buildHtml();
        console.log("[watch] rebuilt ui.html");
      } catch (err) {
        console.error("[watch] ui rebuild failed:", err);
      }
    }, 50);
  };
  fsWatch(path.join(SRC, "ui.ts"), trigger);
  fsWatch(path.join(SRC, "ui.html"), trigger);
  console.log("[watch] watching src/code.ts, src/ui.ts, src/ui.html");
} else {
  await buildAll();
}
