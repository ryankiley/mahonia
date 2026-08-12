// Rasterize the SITE social card (server/utils/ogCard.ts's siteCardVnode) into
// public/og.png — run via `npm run og:site` whenever the template or the fonts
// change. The file is COMMITTED: the generic card is static content, so it ships
// from the CDN with zero lambda work, and the render-failure fallback in
// sendOgCard can point at something that cannot itself fail. tests/ogCard.test.ts
// re-renders the template and byte-compares against the committed file, so
// forgetting to run this after a template change is a red test, not a stale card.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SatoriOptions } from "satori";
import { renderOgSiteCard } from "../server/utils/ogCard";

const root = fileURLToPath(new URL("..", import.meta.url));
const FACES = [
  ["inter-regular.ttf", "Inter", 400],
  ["inter-semibold.ttf", "Inter", 600],
  ["interdisplay-regular.ttf", "InterDisplay", 400],
  ["interdisplay-bold.ttf", "InterDisplay", 700],
] as const;

const fonts: SatoriOptions["fonts"] = await Promise.all(
  FACES.map(async ([file, name, weight]) => ({
    name,
    weight,
    style: "normal" as const,
    data: await readFile(`${root}server/assets/fonts/${file}`),
  })),
);

const png = await renderOgSiteCard(fonts);
await writeFile(`${root}public/og.png`, png);
console.log(`✓ public/og.png — ${png.length} bytes`);
