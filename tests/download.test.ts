import { describe, expect, it } from "vitest";
import { listFileBase } from "../app/utils/download";

describe("listFileBase", () => {
  it("takes the accents off rather than the letters under them", () => {
    expect(listFileBase("Haleakalā", "s")).toBe("haleakala");
    expect(listFileBase("Señal Peak", "s")).toBe("senal-peak");
    expect(listFileBase("Mt. Rainier — Wonderland", "s")).toBe("mt-rainier-wonderland");
  });

  it("drops an apostrophe or an ʻokina inside a word rather than splitting the word at it", () => {
    expect(listFileBase("Keoneheʻeheʻe Trail", "s")).toBe("keoneheehee-trail");
    expect(listFileBase("Arc’teryx kit", "s")).toBe("arcteryx-kit");
    expect(listFileBase("Ryan's list", "s")).toBe("ryans-list");
  });

  it("falls back to the slug when a title has no Latin letters to keep", () => {
    expect(listFileBase("富士山", "fuji-abc")).toBe("fuji-abc");
    expect(listFileBase("", null)).toBe("gear");
  });
});
