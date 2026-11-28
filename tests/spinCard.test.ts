import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderSpinCard } from "../scripts/spinCard";

describe("the committed /trail-spin preview (public/og-trail-spin.png)", () => {
  it("matches its drawing — `npm run og:spin` regenerates it after the drawing or the example changes", async () => {
    const committed = await readFile(new URL("../public/og-trail-spin.png", import.meta.url));
    const fresh = renderSpinCard();
    expect(fresh.equals(committed)).toBe(true);
  });
});
