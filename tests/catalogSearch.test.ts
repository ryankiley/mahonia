import { describe, expect, it } from "vitest";
import {
  hasTokenHit,
  highlightParts,
  isExactOrPrefixMatch,
  isSearchTermRun,
  matchTier,
  mergeCatalogRows,
  rankCandidates,
  trigramScore,
  trigrams,
  typeMatch,
  STRONG_THRESHOLD,
  type LocalCatalogRow,
} from "../shared/catalogSearch";

// The one home for trigram behaviour: the server re-exports trigramScore from
// this same module (server/utils/catalog.ts), so covering it here covers both.
describe("trigrams", () => {
  it("pads each word like pg_trgm (2 leading, 1 trailing)", () => {
    expect(trigrams("cat")).toEqual(new Set(["  c", " ca", "cat", "at "]));
  });
  it("is empty for whitespace/punctuation only", () => {
    expect(trigrams("  -- ").size).toBe(0);
  });
  it("folds diacritics so an accented word tokenizes like its plain spelling", () => {
    expect(trigrams("Fjällräven")).toEqual(trigrams("Fjallraven"));
    expect(trigrams("Klättermusen")).toEqual(trigrams("Klattermusen"));
    expect(trigrams("Wūru")).toEqual(trigrams("Wuru"));
  });
});

describe("trigramScore", () => {
  it("scores a full match 1", () => {
    expect(trigramScore("duplex", "Zpacks Duplex")).toBe(1);
  });
  it("tolerates a typo (a dropped letter still ranks high)", () => {
    expect(trigramScore("duplx", "Zpacks Duplex")).toBeGreaterThan(0.5);
  });
  it("scores an unrelated target low", () => {
    expect(trigramScore("duplx", "MSR PocketRocket 2")).toBeLessThan(0.2);
  });
  it("is case- and punctuation-insensitive across words", () => {
    expect(trigramScore("neoair xlite", "Therm-a-Rest NeoAir XLite")).toBeGreaterThan(0.9);
  });
  it("fully matches an accented target typed in plain ASCII (both directions)", () => {
    expect(trigramScore("Fjallraven", "Fjällräven Keb Hike 30")).toBe(1);
    expect(trigramScore("Fjällräven", "Fjallraven Keb Hike 30")).toBe(1);
  });
});

const row = (over: Partial<LocalCatalogRow>): LocalCatalogRow => ({
  id: 1,
  brand: "Zpacks",
  name: "Duplex",
  variant: null,
  weightMg: 549981,
  weightSource: "manufacturer",
  verified: true,
  usageCount: 0,
  ...over,
});

describe("rankCandidates — the shared ranker", () => {
  it("returns nothing for a query under 2 chars", () => {
    expect(rankCandidates([row({})], "d")).toEqual([]);
  });

  it("filters out rows below the similarity threshold", () => {
    const rows = [row({ id: 1, brand: "Zpacks", name: "Duplex" }), row({ id: 2, brand: "MSR", name: "PocketRocket" })];
    const out = rankCandidates(rows, "duplex");
    expect(out.map((r) => r.id)).toEqual([1]);
  });

  it("ranks verified before unverified, then by usage_count", () => {
    const rows = [
      row({ id: 1, name: "Duplex", verified: false, usageCount: 100 }),
      row({ id: 2, name: "Duplex", verified: true, usageCount: 1 }),
      row({ id: 3, name: "Duplex", verified: true, usageCount: 50 }),
    ];
    const out = rankCandidates(rows, "duplex");
    expect(out.map((r) => r.id)).toEqual([3, 2, 1]); // verified(usage50), verified(usage1), unverified
  });

  it("caps results at the limit", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ id: i + 1, name: "Duplex" }));
    expect(rankCandidates(rows, "duplex", 8)).toHaveLength(8);
  });

  it("returns the autocomplete shape (no usageCount; weightMg numeric)", () => {
    const [r] = rankCandidates([row({ weightMg: 549981 })], "duplex");
    expect(r).toEqual({
      id: 1,
      brand: "Zpacks",
      name: "Duplex",
      variant: null,
      weightMg: 549981,
      weightSource: "manufacturer",
      verified: true,
      searchTerms: null,
      commonName: null,
      categoryHint: null,
      kcal: null,
    });
    expect("usageCount" in (r as object)).toBe(false);
  });

  it("carries categoryHint through, so a pick can pre-classify consumables", () => {
    const [r] = rankCandidates([row({ categoryHint: "consumable" })], "duplex");
    expect(r?.categoryHint).toBe("consumable");
  });

  it("carries kcal through, so a food pick can pre-fill the row's calories", () => {
    const [r] = rankCandidates([row({ categoryHint: "consumable", kcal: 250 })], "duplex");
    expect(r?.kcal).toBe(250);
  });

  it("matches a category noun via search_terms when the name lacks it", () => {
    // "Copper Spur" contains no gear noun; its search_terms carries "tent".
    const rows = [
      row({ id: 1, brand: "Big Agnes", name: "Copper Spur HV UL2", searchTerms: "tent" }),
      row({ id: 2, brand: "MSR", name: "PocketRocket 2", searchTerms: "stove" }),
    ];
    expect(rankCandidates(rows, "tent").map((r) => r.id)).toEqual([1]);
  });

  it("finds an accented brand typed in plain ASCII, and vice versa", () => {
    const rows = [
      row({ id: 1, brand: "Fjällräven", name: "Keb Hike 30", searchTerms: "backpack" }),
      row({ id: 2, brand: "MSR", name: "PocketRocket 2", searchTerms: "stove" }),
    ];
    expect(rankCandidates(rows, "Fjallraven").map((r) => r.id)).toEqual([1]);
    expect(rankCandidates(rows, "Fjällräven").map((r) => r.id)).toEqual([1]);
  });

  it("matches a locale/synonym term folded into search_terms", () => {
    // A backpack row is found by the UK term "rucksack" (aliased into search_terms).
    const rows = [
      row({ id: 1, brand: "Osprey", name: "Exos 58", searchTerms: "backpack rucksack" }),
      row({ id: 2, brand: "Zpacks", name: "Duplex", searchTerms: "tent" }),
    ];
    expect(rankCandidates(rows, "rucksack").map((r) => r.id)).toEqual([1]);
    expect(rankCandidates(rows, "backpack").map((r) => r.id)).toEqual([1]);
  });
});

describe("isExactOrPrefixMatch", () => {
  it("matches an exact folded query", () => {
    expect(isExactOrPrefixMatch("zpacks duplex", "Zpacks Duplex")).toBe(true);
  });
  it("matches a whole-string prefix (last word still being typed)", () => {
    expect(isExactOrPrefixMatch("zpacks dup", "Zpacks Duplex")).toBe(true);
  });
  it("matches a single word at a later word boundary", () => {
    expect(isExactOrPrefixMatch("duplex", "Zpacks Duplex")).toBe(true);
  });
  it("matches a multi-word query aligned mid-name, last token a prefix", () => {
    // "x mid 2" aligns with "…x mid 2 pro"; "2" prefixes the "2" token.
    expect(isExactOrPrefixMatch("x mid 2", "Durston X-Mid 2 Pro")).toBe(true);
  });
  it("does NOT match a mid-word substring (no word boundary)", () => {
    expect(isExactOrPrefixMatch("plex", "Zpacks Duplex")).toBe(false);
  });
  it("folds diacritics so plain ASCII matches an accented name", () => {
    expect(isExactOrPrefixMatch("fjallraven", "Fjällräven Keb Hike 30")).toBe(true);
  });
  it("is false for an empty query", () => {
    expect(isExactOrPrefixMatch("", "Zpacks Duplex")).toBe(false);
  });
});

describe("matchTier", () => {
  it("is 0 when the query names the row's kind of gear, whatever the name says", () => {
    expect(matchTier("tent", "Big Agnes Copper Spur HV UL2", 1, "Tent", "tent")).toBe(0);
  });
  it("is 1 for an exact/prefix match on the name regardless of score", () => {
    expect(matchTier("duplex", "Zpacks Duplex", 0.4)).toBe(1);
  });
  it("is 2 for a strong (>= STRONG_THRESHOLD) fuzzy match that also starts a word of the target", () => {
    expect(matchTier("hyperl wind", "Hyperlite Mountain Gear Windrider", STRONG_THRESHOLD)).toBe(2);
  });
  it("is 3 for a strong score with no word-boundary hit: coverage alone is not evidence", () => {
    // "battery" shares att/tte/ter with the brand and " ba" with "bag" (0.625) and
    // starts no word of the target
    expect(matchTier("battery", "Klättermusen Hrid WP Accessory Bag", 0.625, "Dry bag", "dry bag")).toBe(3);
    // a typo is recall, not a peer of a real match: rankCandidates keeps it only
    // when nothing better matched
    expect(matchTier("duplx", "Zpacks Duplex", 0.72)).toBe(3);
  });
  it("is 3 for a weak match that only cleared the gate", () => {
    expect(matchTier("duplx", "Zpacks Duplex", 0.4)).toBe(3);
  });
});

describe("rankCandidates ordering", () => {
  it("lets a better textual match win: a prefix-match unverified row beats a fuzzy verified one", () => {
    const rows = [
      row({ id: 1, brand: null, name: "X-Mid 2", verified: false, usageCount: 0 }),
      row({ id: 2, brand: null, name: "X-Mid Pro", verified: true, usageCount: 100 }),
    ];
    // "x mid 2" exact-matches id 1 (tier 1); id 2 is only a strong fuzzy (tier 2).
    expect(rankCandidates(rows, "x mid 2").map((r) => r.id)).toEqual([1, 2]);
  });

  it("ranks by tier before usage_count, and drops a weak typo row once real matches exist", () => {
    const rows = [
      row({ id: 1, name: "Duplex", verified: true, usageCount: 1 }),
      row({ id: 2, name: "Duplex", verified: true, usageCount: 50 }),
      row({ id: 3, name: "Duplux", verified: true, usageCount: 999 }), // typo → not exact
    ];
    // exact rows first (by usage); the weak-but-hugely-used typo row is junk beside
    // them and goes (it would still answer a query nothing else matched)
    expect(rankCandidates(rows, "duplex").map((r) => r.id)).toEqual([2, 1]);
  });

  it("breaks exact ties deterministically by id ascending (no keystroke jitter)", () => {
    const rows = [
      row({ id: 5, name: "Duplex", verified: true, usageCount: 0 }),
      row({ id: 3, name: "Duplex", verified: true, usageCount: 0 }),
    ];
    expect(rankCandidates(rows, "duplex").map((r) => r.id)).toEqual([3, 5]);
  });

  it("respects the limit after re-ranking a pool", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: i + 1, name: "Duplex" }));
    expect(rankCandidates(rows, "duplex", 12)).toHaveLength(12);
  });

  it("surfaces a high-usage row buried at a large id among many equal-similarity ties", () => {
    // A common-token query ties hundreds of rows at similarity 1.0 (all "Duplex").
    // The winner (verified + high usage) sits at the LARGEST id, so any pre-rank
    // truncation by (similarity, id) would drop it. Passing the full set to the
    // re-ranker must still float it to the top — this is why the Neon path fetches
    // every gated row rather than a top-N-by-similarity pool.
    const rows = Array.from({ length: 300 }, (_, i) =>
      row({ id: i + 1, name: "Duplex", verified: false, usageCount: 0 }),
    );
    rows.push(row({ id: 999, name: "Duplex", verified: true, usageCount: 500 }));
    expect(rankCandidates(rows, "duplex", 12)[0]!.id).toBe(999);
  });
});

describe("typeMatch", () => {
  it("is 2 when the query is the whole common name, last token still typing", () => {
    expect(typeMatch("tent", "Tent")).toBe(2);
    expect(typeMatch("sleeping ba", "Sleeping bag")).toBe(2);
  });
  it("is 1 when the query is a leading prefix of a longer type", () => {
    expect(typeMatch("sleeping bag", "Sleeping bag liner")).toBe(1);
    expect(typeMatch("sleeping", "Sleeping pad")).toBe(1);
  });
  it("is 0 for a different type, a non-leading word, or no common name", () => {
    expect(typeMatch("tent", "Groundsheet")).toBe(0);
    expect(typeMatch("bag", "Sleeping bag")).toBe(0);
    expect(typeMatch("tent", null)).toBe(0);
  });
});

describe("hasTokenHit / isSearchTermRun", () => {
  it("needs a 3+ char query token to start a target word", () => {
    expect(hasTokenHit("copper", "Enlightened Equipment Copperfield Wind Pants")).toBe(true);
    expect(hasTokenHit("battery", "Klättermusen Hrid WP Accessory Bag dry bag")).toBe(false);
    expect(hasTokenHit("ul", "Copper Spur HV UL2")).toBe(false);
  });
  it("finds the query as a run of the derived search terms, last token a prefix", () => {
    expect(isSearchTermRun("puffy", "down jacket puffy")).toBe(true);
    expect(isSearchTermRun("down jack", "down jacket puffy")).toBe(true);
    expect(isSearchTermRun("tensor", "sleeping pad")).toBe(false);
    expect(isSearchTermRun("tent", null)).toBe(false);
  });
});

describe("rankCandidates — kind-of-gear queries", () => {
  const pad = (id: number, brand: string, name: string, variant: string | null = null) =>
    row({ id, brand, name, variant, commonName: "Sleeping pad", searchTerms: "sleeping pad" });

  it("puts rows OF the type above a row with the word in its name", () => {
    const rows = [
      row({ id: 1, brand: "Gossamer Gear", name: "Polycro Tent Ground Cloth", commonName: "Groundsheet", searchTerms: "tent" }),
      row({ id: 2, brand: "Big Agnes", name: "Copper Spur HV UL2", commonName: "Tent", searchTerms: "tent" }),
      row({ id: 3, brand: "Zpacks", name: "Duplex", commonName: "Tent", searchTerms: "tent" }),
    ];
    expect(rankCandidates(rows, "tent").map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("puts the whole type above a longer type it merely prefixes (bags before liners)", () => {
    const rows = [
      row({ id: 1, brand: "Big Agnes", name: "Alpha Direct Fleece Sleeping Bag Liner", commonName: "Sleeping bag liner", searchTerms: "sleeping bag liner" }),
      row({ id: 2, brand: "Cumulus", name: "Aerial 180", commonName: "Sleeping bag", searchTerms: "sleeping bag" }),
    ];
    expect(rankCandidates(rows, "sleeping bag").map((r) => r.id)).toEqual([2, 1]);
  });

  it("drops weak fuzzy rows once anything better matched, and keeps them when nothing did", () => {
    const rows = [
      row({ id: 1, brand: "Nitecore", name: "Carbon Battery 6k Power Bank", commonName: "Power bank", searchTerms: "power bank" }),
      row({ id: 2, brand: "Klättermusen", name: "Hrid WP Accessory Bag", commonName: "Dry bag", searchTerms: "dry bag" }),
    ];
    expect(rankCandidates(rows, "battery").map((r) => r.id)).toEqual([1]);
    expect(rankCandidates([row({ id: 3, name: "Duplex" })], "duplx").map((r) => r.id)).toEqual([3]);
  });

  it("returns nothing for a multi-word query that starts no word of any row (a custom name)", () => {
    const rows = [
      row({ id: 1, brand: "Chicken Tramper Gear", name: "Bear Can Key" }),
      row({ id: 2, brand: "Katadyn", name: "BeFree Activated Carbon Flip Cap" }),
    ];
    expect(rankCandidates(rows, "my car keys")).toEqual([]);
  });

  it("caps a kind-of-gear query at two rows per product and two per brand, then backfills", () => {
    const rows = [
      ...["Regular", "Regular Wide", "Long Wide", "Regular Mummy", "Short"].map((v, i) => pad(i + 1, "Nemo", "Tensor All-Season", v)),
      pad(6, "Nemo", "Tensor Elite", "Regular"),
      pad(7, "Nemo", "Switchback"),
      pad(8, "Therm-a-Rest", "NeoAir XLite NXT"),
    ];
    // two Tensor All-Seasons fill Nemo's two slots, the Therm-a-Rest follows, then the
    // capped Nemo rows fill the rest in their original order
    expect(rankCandidates(rows, "sleeping pad").map((r) => r.id)).toEqual([1, 2, 8, 3, 4, 5, 6, 7]);
  });

  it("does not cap a query that names the product: every size comes back", () => {
    const rows = ["Regular", "Regular Wide", "Long Wide", "Regular Mummy", "Short"].map((v, i) => pad(i + 1, "Nemo", "Tensor All-Season", v));
    expect(rankCandidates(rows, "tensor").map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats a synonym in search_terms as a kind-of-gear query too", () => {
    const puffy = (id: number, name: string, variant: string) =>
      row({ id, brand: "Arc'teryx", name, variant, commonName: "Down jacket", searchTerms: "down jacket puffy" });
    const rows = [
      puffy(1, "Cerium Hoody", "Men's"),
      puffy(2, "Cerium Hoody", "Women's"),
      puffy(3, "Cerium SL Hoody", "Men's"),
      puffy(4, "Cerium SL Hoody", "Women's"),
      row({ id: 5, brand: "Katabatic Gear", name: "Tarn", commonName: "Down jacket", searchTerms: "down jacket puffy" }),
    ];
    // the Men's/Women's pair fills Arc'teryx's two slots, Katabatic follows, and the
    // capped Arc'teryx rows backfill
    expect(rankCandidates(rows, "puffy").map((r) => r.id)).toEqual([1, 2, 5, 3, 4]);
  });
});

describe("mergeCatalogRows", () => {
  it("dedups by id, with the incoming (fresher) copy winning", () => {
    const existing = [row({ id: 1, name: "Duplex", weightMg: 1000 })];
    const incoming = [row({ id: 1, name: "Duplex", weightMg: 2000 })];
    const merged = mergeCatalogRows(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.weightMg).toBe(2000); // fresher value kept
  });

  it("puts most-recently-seen rows first", () => {
    const existing = [row({ id: 1 }), row({ id: 2 })];
    const incoming = [row({ id: 3 })];
    expect(mergeCatalogRows(existing, incoming).map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it("caps the cache, evicting the oldest", () => {
    const existing = Array.from({ length: 5 }, (_, i) => row({ id: i + 1 }));
    const incoming = [row({ id: 99 })];
    const merged = mergeCatalogRows(existing, incoming, 3);
    expect(merged.map((r) => r.id)).toEqual([99, 1, 2]); // newest kept, oldest dropped
  });
});

// The apostrophe fold exists because a row that RANKS but highlights nothing reads as
// "this isn't the match you asked for". foldForSearch strips diacritics too — its own
// comment names Fjällräven — so the highlighter has to fold them or it reopens the hole.
describe("highlightParts — accents", () => {
  const on = (text: string, q: string) =>
    highlightParts(text, q)
      .filter((p) => p.on)
      .map((p) => p.t)
      .join("");

  it("marks the match when the query drops the accents", () => {
    expect(on("Fjällräven Abisko", "fjallraven")).toBe("Fjällräven");
    expect(on("NeoAir Café", "cafe")).toBe("Café");
  });

  it("still marks it when the query carries them", () => {
    expect(on("Fjällräven Abisko", "fjällräven")).toBe("Fjällräven");
  });

  it("keeps both apostrophe spellings working", () => {
    expect(on("Arc\u2019teryx Beta", "arc'teryx")).toBe("Arc\u2019teryx");
    expect(on("Arc\u2019teryx Beta", "arc\u2019teryx")).toBe("Arc\u2019teryx");
  });

  it("puts the parts back together as the original text", () => {
    for (const q of ["fjallraven", "cafe", "arc'teryx", "(a+)+", "\\"]) {
      const text = "Fjällräven Arc\u2019teryx Café";
      expect(highlightParts(text, q).map((p) => p.t).join("")).toBe(text);
    }
  });
});
