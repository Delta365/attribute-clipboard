// Converts the SVG sources in this folder into 1x PNG assets that can be
// uploaded to the Figma Community publish form, and that GitHub renders
// reliably inline in the README (SVG filter rendering on GitHub's image
// proxy is inconsistent; PNG is the safe deliverable).
//
// Run with:  npm run rasterize-assets

import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const targets = [
  { input: "cover.svg", output: "cover.png", width: 1920 },
  { input: "icon.svg", output: "icon.png", width: 128 },
];

for (const t of targets) {
  const svg = readFileSync(resolve(here, t.input));
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: t.width },
    font: {
      // Help resvg find Inter on the developer's machine. The library does
      // its own system discovery on top of these hints.
      fontDirs: [
        "/System/Library/Fonts",
        "/Library/Fonts",
        process.env.HOME + "/Library/Fonts",
      ],
      defaultFontFamily: "Inter",
      loadSystemFonts: true,
    },
  });
  const png = resvg.render().asPng();
  const outPath = resolve(here, t.output);
  writeFileSync(outPath, png);
  console.log(`[rasterize] ${t.output} (${(png.length / 1024).toFixed(1)} KB)`);
}
