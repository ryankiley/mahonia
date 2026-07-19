import { describe, expect, it } from "vitest";
import {
  isExactOrPrefixMatch,
  matchTier,
  mergeCatalogRows,
  rankCandidates,
  searchCatalogLocal,
  trigramScore,
  trigrams,
  STRONG_THRESHOLD,
  type LocalCatalogRow,
} from "../shared/catalogSearch";

// These mirror tests/catalog.test.ts so the extraction to shared/ is provably
// behaviour-preserving (the server re-exports these same functions).
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

describe("searchCatalogLocal", () => {
  it("returns nothing for a query under 2 chars", () => {
    expect(searchCatalogLocal([row({})], "d")).toEqual([]);
  });

  it("filters out rows below the similarity threshold", () => {
    const rows = [row({ id: 1, brand: "Zpacks", name: "Duplex" }), row({ id: 2, brand: "MSR", name: "PocketRocket" })];
    const out = searchCatalogLocal(rows, "duplex");
    expect(out.map((r) => r.id)).toEqual([1]);
  });

  it("ranks verified before unverified, then by usage_count", () => {
    const rows = [
      row({ id: 1, name: "Duplex", verified: false, usageCount: 100 }),
      row({ id: 2, name: "Duplex", verified: true, usageCount: 1 }),
      row({ id: 3, name: "Duplex", verified: true, usageCount: 50 }),
    ];
    const out = searchCatalogLocal(rows, "duplex");
    expect(out.map((r) => r.id)).toEqual([3, 2, 1]); // verified(usage50), verified(usage1), unverified
  });

  it("caps results at the limit", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ id: i + 1, name: "Duplex" }));
    expect(searchCatalogLocal(rows, "duplex", 8)).toHaveLength(8);
  });

  it("returns the autocomplete shape (no usageCount; weightMg numeric)", () => {
    const [r] = searchCatalogLocal([row({ weightMg: 549981 })], "duplex");
    expect(r).toEqual({
      id: 1,
      brand: "Zpacks",
      name: "Duplex",
      variant: null,
      weightMg: 549981,
      weightSource: "manufacturer",
      verified: true,
      searchTerms: null,
    });
    expect("usageCount" in (r as object)).toBe(false);
  });

  it("matches a category noun via search_terms when the name lacks it", () => {
    // "Copper Spur" contains no gear noun; its search_terms carries "tent".
    const rows = [
      row({ id: 1, brand: "Big Agnes", name: "Copper Spur HV UL2", searchTerms: "tent" }),
      row({ id: 2, brand: "MSR", name: "PocketRocket 2", searchTerms: "stove" }),
    ];
    expect(searchCatalogLocal(rows, "tent").map((r) => r.id)).toEqual([1]);
  });

  it("finds an accented brand typed in plain ASCII, and vice versa", () => {
    const rows = [
      row({ id: 1, brand: "Fjällräven", name: "Keb Hike 30", searchTerms: "backpack" }),
      row({ id: 2, brand: "MSR", name: "PocketRocket 2", searchTerms: "stove" }),
    ];
    expect(searchCatalogLocal(rows, "Fjallraven").map((r) => r.id)).toEqual([1]);
    expect(searchCatalogLocal(rows, "Fjällräven").map((r) => r.id)).toEqual([1]);
  });

  it("matches a locale/synonym term folded into search_terms", () => {
    // A backpack row is found by the UK term "rucksack" (aliased into search_terms).
    const rows = [
      row({ id: 1, brand: "Osprey", name: "Exos 58", searchTerms: "backpack rucksack" }),
      row({ id: 2, brand: "Zpacks", name: "Duplex", searchTerms: "tent" }),
    ];
    expect(searchCatalogLocal(rows, "rucksack").map((r) => r.id)).toEqual([1]);
    expect(searchCatalogLocal(rows, "backpack").map((r) => r.id)).toEqual([1]);
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
  it("is 0 for an exact/prefix match regardless of score", () => {
    expect(matchTier("duplex", "Zpacks Duplex", 0.4)).toBe(0);
  });
  it("is 1 for a strong (>= STRONG_THRESHOLD) non-prefix fuzzy match", () => {
    expect(matchTier("duplx", "Zpacks Duplex", STRONG_THRESHOLD)).toBe(1);
    expect(matchTier("duplx", "Zpacks Duplex", 0.72)).toBe(1);
  });
  it("is 2 for a weak match that only cleared the gate", () => {
    expect(matchTier("duplx", "Zpacks Duplex", 0.4)).toBe(2);
  });
});

describe("rankCandidates ordering", () => {
  it("lets a better textual match win: a Tier-0 unverified row beats a Tier-1 verified one", () => {
    const rows = [
      row({ id: 1, brand: null, name: "X-Mid 2", verified: false, usageCount: 0 }),
      row({ id: 2, brand: null, name: "X-Mid Pro", verified: true, usageCount: 100 }),
    ];
    // "x mid 2" exact-matches id 1 (Tier 0); id 2 is only a strong fuzzy (Tier 1).
    expect(rankCandidates(rows, "x mid 2").map((r) => r.id)).toEqual([1, 2]);
  });

  it("ranks by tier before usage_count: an exact match beats a high-usage weak match", () => {
    const rows = [
      row({ id: 1, name: "Duplex", verified: true, usageCount: 1 }),
      row({ id: 2, name: "Duplex", verified: true, usageCount: 50 }),
      row({ id: 3, name: "Duplux", verified: true, usageCount: 999 }), // typo → not exact
    ];
    // Tier-0 exact rows first (by usage), then the weak-but-hugely-used row last.
    expect(rankCandidates(rows, "duplex").map((r) => r.id)).toEqual([2, 1, 3]);
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
