// The card renderer's four faces, read once per instance from Nitro's bundled
// server assets (server/assets/fonts — subset TTFs; how they were made and what
// they cover is documented there and pinned by tests/ogCard.test.ts). Loaded
// lazily so a deploy that never serves a card never reads them; memoized
// shares one read across concurrent first requests and retries after a
// transient failure instead of caching the rejection. (`useStorage` is a Nitro
// auto-import — same convention as rateLimit.ts.)

import type { SatoriOptions } from "satori";
import { OG_FONT_FACES } from "../../shared/ogCard";
import { memoized } from "./memoize";

export const ogFonts = memoized(async (): Promise<SatoriOptions["fonts"]> => {
  const storage = useStorage("assets:server");
  return Promise.all(
    OG_FONT_FACES.map(async ([file, name, weight]) => {
      const data = (await storage.getItemRaw(`fonts:${file}`)) as Buffer | null;
      if (!data) throw new Error(`og card font missing from server assets: ${file}`);
      return { name, weight, style: "normal" as const, data };
    }),
  );
});
