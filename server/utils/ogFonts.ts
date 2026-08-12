// The card renderer's four faces, read once per instance from Nitro's bundled
// server assets (server/assets/fonts — subset TTFs; how they were made and what
// they cover is documented at shared/ogCard.ts's DRAWABLE). Loaded lazily so a
// deploy that never serves a card never reads them, and cached as the promise so
// concurrent first requests share one read. (`useStorage` is a Nitro
// auto-import — same convention as rateLimit.ts.)

import type { SatoriOptions } from "satori";

let fonts: Promise<SatoriOptions["fonts"]> | null = null;

export function ogFonts(): Promise<SatoriOptions["fonts"]> {
  fonts ??= loadAll();
  return fonts;
}

async function loadAll(): Promise<SatoriOptions["fonts"]> {
  const storage = useStorage("assets:server");
  const load = async (file: string): Promise<Buffer> => {
    const data = (await storage.getItemRaw(`fonts:${file}`)) as Buffer | null;
    if (!data) throw new Error(`og card font missing from server assets: ${file}`);
    return data;
  };
  const [regular, semibold, displayRegular, displayBold] = await Promise.all([
    load("inter-regular.ttf"),
    load("inter-semibold.ttf"),
    load("interdisplay-regular.ttf"),
    load("interdisplay-bold.ttf"),
  ]);
  return [
    { name: "Inter", weight: 400, style: "normal", data: regular },
    { name: "Inter", weight: 600, style: "normal", data: semibold },
    { name: "InterDisplay", weight: 400, style: "normal", data: displayRegular },
    { name: "InterDisplay", weight: 700, style: "normal", data: displayBold },
  ];
}
