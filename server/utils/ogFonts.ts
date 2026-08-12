// The card renderer's four faces, read once per instance from Nitro's bundled
// server assets (server/assets/fonts — subset TTFs; how they were made and what
// they cover is documented there and pinned by tests/ogCard.test.ts). Loaded
// lazily so a deploy that never serves a card never reads them; memoizedOnce
// shares one read across concurrent first requests and retries after a
// transient failure instead of caching the rejection. (`useStorage` is a Nitro
// auto-import — same convention as rateLimit.ts.)

import type { SatoriOptions } from "satori";
import { memoizedOnce } from "./memoize";

const FACES = [
  ["inter-regular.ttf", "Inter", 400],
  ["inter-semibold.ttf", "Inter", 600],
  ["interdisplay-regular.ttf", "InterDisplay", 400],
  ["interdisplay-bold.ttf", "InterDisplay", 700],
] as const;

export const ogFonts = memoizedOnce(async (): Promise<SatoriOptions["fonts"]> => {
  const storage = useStorage("assets:server");
  return Promise.all(
    FACES.map(async ([file, name, weight]) => {
      const data = (await storage.getItemRaw(`fonts:${file}`)) as Buffer | null;
      if (!data) throw new Error(`og card font missing from server assets: ${file}`);
      return { name, weight, style: "normal" as const, data };
    }),
  );
});
