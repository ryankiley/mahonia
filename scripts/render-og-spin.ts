// Rasterize /trail-spin's link preview (scripts/spinCard.ts) into public/og-trail-spin.png — run via
// `npm run og:spin` whenever the drawing or the example route changes. The file is
// committed and served as it is, like public/og.png; tests/spinCard.test.ts fails while it is
// stale.
import { writeFile } from "node:fs/promises";
import { renderSpinCard } from "./spinCard";

const png = renderSpinCard();
await writeFile(new URL("../public/og-trail-spin.png", import.meta.url), png);
console.log(`✓ public/og-trail-spin.png — ${png.length} bytes`);
