import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { foldApostrophes, tidyProse, tidyText } from "../shared/tidyText";

// The character class the tidy strips, spelled out here so a test failure names the
// character rather than showing two identical-looking strings.
const ZWSP = String.fromCharCode(0x200b);
const ZWNJ = String.fromCharCode(0x200c);
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0x00a0);
const CURLY = String.fromCharCode(0x2019);

describe("tidyText — whitespace", () => {
  it("trims the ends and collapses internal runs", () => {
    expect(tidyText("  Ryan's   Timberline  ")).toBe(`Ryan${CURLY}s Timberline`);
  });

  it("folds a non-breaking space into a normal one rather than deleting it", () => {
    // pasting "Zpacks Duplex" off a retailer page routinely brings one of these; the
    // words must stay two words, so this is a FOLD, not a strip
    expect(tidyText(`Zpacks${NBSP}Duplex`)).toBe("Zpacks Duplex");
  });

  it("strips the zero-width characters that survive a paste", () => {
    expect(tidyText(`Dup${ZWSP}lex`)).toBe("Duplex");
    expect(tidyText(`${BOM}Duplex`)).toBe("Duplex");
    // …but NOT the joiners. This assertion used to read `.toBe("Duplex")` — it pinned
    // the bug rather than the behaviour, and it passed. See the "characters that carry
    // meaning" block below for why U+200C/U+200D are content.
    expect(tidyText(`Dup${ZWNJ}lex`)).toBe(`Dup${ZWNJ}lex`);
  });

  it("strips control characters without leaving a gap", () => {
    expect(tidyText(`Dup${String.fromCharCode(1)}lex`)).toBe("Duplex");
    expect(tidyText(`Dup${String.fromCharCode(0x7f)}lex`)).toBe("Duplex");
  });

  it("flattens newlines — every field it runs on is a one-line field", () => {
    expect(tidyText("Sierra High Route\nSeptember 2026")).toBe("Sierra High Route September 2026");
    expect(tidyText("a\r\n\tb")).toBe("a b");
  });

  it("reduces a whitespace-only value to empty, so callers can treat it as blank", () => {
    expect(tidyText("   ")).toBe("");
    expect(tidyText(`${ZWSP}${NBSP}`)).toBe("");
  });
});

describe("tidyText — apostrophes", () => {
  it("curls a possessive and a contraction", () => {
    expect(tidyText("Ryan's Timberline")).toBe(`Ryan${CURLY}s Timberline`);
    expect(tidyText("don't forget")).toBe(`don${CURLY}t forget`);
  });

  it("curls apostrophes inside a brand name", () => {
    // the three spellings this catalog actually carries
    expect(tidyText("Arc'teryx")).toBe(`Arc${CURLY}teryx`);
    expect(tidyText("Pa'lante")).toBe(`Pa${CURLY}lante`);
    expect(tidyText("Coghlan's")).toBe(`Coghlan${CURLY}s`);
  });

  it("reads non-ASCII letters as letters", () => {
    expect(tidyText("l'eau")).toBe(`l${CURLY}eau`);
    expect(tidyText("Fjällräven's")).toBe(`Fjällräven${CURLY}s`);
  });

  // The reason the rule is letter-flanked and nothing wider. seed/catalog.csv carries
  // dozens of each of these; curling one silently rewrites a measurement.
  it("leaves a foot mark alone", () => {
    expect(tidyText("6' guyline")).toBe("6' guyline");
    expect(tidyText("Tarp 8' x 10'")).toBe("Tarp 8' x 10'");
  });

  it("leaves an inch mark alone", () => {
    expect(tidyText('MSR 2" stakes')).toBe('MSR 2" stakes');
    expect(tidyText(`5'10"`)).toBe(`5'10"`);
  });

  it("leaves every other straight quote alone — no dashes, no double quotes", () => {
    expect(tidyText('the "ultralight" kit')).toBe('the "ultralight" kit');
    expect(tidyText("tarp -- 2 person")).toBe("tarp -- 2 person");
    expect(tidyText("wait...")).toBe("wait...");
  });

  it("leaves a trailing plural possessive straight", () => {
    // deliberate: "boys'" has no letter after the apostrophe, and widening the rule to
    // reach it is what would start reaching feet marks too. Zero rows in the catalog
    // spell a possessive this way.
    expect(tidyText("the boys' tent")).toBe("the boys' tent");
  });
});

describe("tidyText — invariants", () => {
  it("never grows the string, so a caller may clamp before tidying", () => {
    for (const s of ["Ryan's", `a${NBSP}${NBSP}b`, `x${ZWSP}y`, "  padded  ", '6\' 2"']) {
      expect(tidyText(s).length).toBeLessThanOrEqual(s.length);
    }
  });

  it("is idempotent — tidying stored text again is a no-op", () => {
    for (const s of ["Ryan's Timberline", "6' guyline", `Arc'teryx Men's Beta`, "  a  b  "]) {
      expect(tidyText(tidyText(s))).toBe(tidyText(s));
    }
  });

  it("leaves an already-curled string untouched", () => {
    expect(tidyText(`Ryan${CURLY}s Timberline`)).toBe(`Ryan${CURLY}s Timberline`);
  });
});

describe("tidyText — the regex itself", () => {
  it("curls consecutive possessives, which the capture-group form could have broken", () => {
    // the leading letter is CONSUMED by the match rather than matched by a lookbehind
    // (Safari <16.4 can't parse lookbehind). The engine resumes on the letter the next
    // match needs, so an adjacent pair still both curl — this is the guard on that.
    expect(tidyText("a'b'c")).toBe(`a${CURLY}b${CURLY}c`);
    expect(tidyText("Ryan's don't O'Brien's")).toBe(
      `Ryan${CURLY}s don${CURLY}t O${CURLY}Brien${CURLY}s`,
    );
  });

  it("leaves a doubled apostrophe alone — neither side is letter-flanked", () => {
    expect(tidyText("a''b")).toBe("a''b");
  });

  it("uses no regex syntax newer than Safari 11.1", () => {
    // A lookbehind is a PARSE error, not a failed match: it would take the whole chunk
    // down on an old iPhone rather than merely skipping the curl, so this can't be
    // caught by exercising the function — by the time it runs, it already parsed. Read
    // the SOURCE, so rewriting the rule the obvious way trips here instead of on a
    // phone. (tidyText.toString() is no good: the regexes are module consts, so the
    // body shows their names and never the syntax.)
    const src = readFileSync(new URL("../shared/tidyText.ts", import.meta.url), "utf8");
    expect(src).toContain("'"); // sanity: we're reading the right file
    expect(src).not.toContain("(?<=");
    expect(src).not.toContain("(?<!");
  });
});

// Characters that LOOK like debris and are not. Each of these was actually broken by
// the first version of this file — it stripped U+200C/U+200D the way every "remove
// invisible characters" snippet does, and collapsed U+3000 because \s matches it.
// The user can't type any of them back, so they are pinned here.
describe("tidyText — characters that carry meaning", () => {
  const ZWJ = String.fromCharCode(0x200d);
  const ZWNJ = String.fromCharCode(0x200c);
  const IDEO = String.fromCharCode(0x3000);

  it("keeps the zero-width JOINER — it is what makes one emoji out of two", () => {
    const astronaut = "👩‍🚀";
    expect(tidyText(`${astronaut} Space kit`)).toBe(`${astronaut} Space kit`);
    // the count is the point: 3 code points in, 3 out — a strip would leave 2 glyphs
    expect([...tidyText(astronaut)].length).toBe(3);
    expect(tidyText(astronaut).includes(ZWJ)).toBe(true);
  });

  it("keeps a multi-joiner sequence intact", () => {
    const flag = "🏳️‍🌈";
    expect(tidyText(`${flag} Pride hike`)).toBe(`${flag} Pride hike`);
  });

  it("keeps the zero-width NON-joiner — Persian spelling depends on it", () => {
    const word = "می‌روم";
    expect(tidyText(word)).toBe(word);
    expect(tidyText(word).includes(ZWNJ)).toBe(true);
  });

  it("keeps the ideographic space — it is deliberate spacing, not stray whitespace", () => {
    const name = "山田　太郎";
    expect(tidyText(name)).toBe(name);
    expect(tidyText(name).includes(IDEO)).toBe(true);
    // and it does not become a Latin space
    expect(tidyText(name)).not.toBe("山田 太郎");
  });

  it("still collapses ordinary whitespace sitting next to an ideographic space", () => {
    expect(tidyText(`a   ${IDEO}   b`)).toBe(`a ${IDEO} b`);
  });

  it("still strips the marks that ARE debris", () => {
    const ZWSP = String.fromCharCode(0x200b);
    const BOM = String.fromCharCode(0xfeff);
    expect(tidyText(`Dup${ZWSP}lex`)).toBe("Duplex");
    expect(tidyText(`${BOM}Duplex`)).toBe("Duplex");
  });
});

describe("tidyText — the ideographic space is content inside, whitespace at the edges", () => {
  const IDEO = String.fromCharCode(0x3000);

  it("trims a stray full-width space off either end", () => {
    expect(tidyText(`${IDEO}山田${IDEO}太郎${IDEO}`)).toBe(`山田${IDEO}太郎`);
  });

  it("treats a value of nothing but full-width space as blank", () => {
    // the asymmetry earns its keep here: exempting U+3000 from the trim too meant this
    // came back non-empty, which is enough to skip normalizeFolder's "Folder" fallback
    expect(tidyText(IDEO)).toBe("");
    expect(tidyText(`${IDEO}${IDEO}`)).toBe("");
  });
});

// Ported from the adversarial review's fuzz pass. Both properties are relied on by
// callers: ops.ts slices to a cap BEFORE tidying (so growth would breach the cap), and
// normalizeItem re-tidies already-stored text on every load and JSON restore (so a
// non-fixed-point would rewrite rows forever).
describe("tidyText — fuzzed invariants", () => {
  const ALPHABET = [
    "a", "b", "Z", "é", "'", '"', " ", "\t", "\n", "\r",
    String.fromCharCode(0x00a0), String.fromCharCode(0x200b),
    String.fromCharCode(0x200c), String.fromCharCode(0x200d),
    String.fromCharCode(0xfeff), String.fromCharCode(0x2019),
    String.fromCharCode(0x3000), String.fromCharCode(0x0001),
    "1", "6", "-", ".", "\u{1F600}", "µ", "ß", "்", "あ",
  ];
  const mkRand = (seed) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  it("is a fixed point after one pass, and never grows (50k strings)", () => {
    const rand = mkRand(123456789);
    const bad = [];
    for (let n = 0; n < 50_000 && bad.length < 5; n++) {
      let s = "";
      const len = 1 + Math.floor(rand() * 9);
      for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      const a = tidyText(s);
      if (a !== tidyText(a)) bad.push(`NOT FIXED ${JSON.stringify(s)} -> ${JSON.stringify(a)}`);
      if (a.length > s.length) bad.push(`GREW ${JSON.stringify(s)} -> ${JSON.stringify(a)}`);
    }
    expect(bad).toEqual([]);
  });

  it("slice-then-tidy honours the cap and is a fixed point (25k strings)", () => {
    const clean = (raw, max) => tidyText(raw.slice(0, max));
    const rand = mkRand(987654321);
    const bad = [];
    for (let n = 0; n < 25_000 && bad.length < 5; n++) {
      let s = "";
      const len = 1 + Math.floor(rand() * 16);
      for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      const max = 1 + Math.floor(rand() * 14);
      const a = clean(s, max);
      if (a !== clean(a, max)) bad.push(`NOT FIXED ${JSON.stringify(s)} max=${max}`);
      if (a.length > max) bad.push(`OVER CAP ${JSON.stringify(s)} max=${max}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("foldApostrophes — the literal filters' fold", () => {
  it("folds every spelling tidyText can produce, and the ones keyboards emit", () => {
    for (const mark of ["\u2019", "\u2018", "\u02bc"]) {
      expect(foldApostrophes(`Ryan${mark}s`)).toBe("Ryan's");
    }
  });

  it("makes a tidied row findable by the apostrophe a keyboard types", () => {
    const stored = tidyText("Ryan's repair kit").toLowerCase();
    expect(stored.includes("ryan's")).toBe(false); // the bug this exists for
    expect(foldApostrophes(stored).includes(foldApostrophes("ryan's"))).toBe(true);
  });

  it("matches mid-keystroke, before the apostrophe has a letter after it", () => {
    // tidyText("Ryan'") can't curl yet, so a tidy-the-query fix would blank the list
    // for exactly one keystroke. Folding both sides has no such gap.
    const stored = foldApostrophes(tidyText("Ryan's repair kit").toLowerCase());
    for (const partial of ["ryan", "ryan'", "ryan's", "ryan\u2019s"]) {
      expect(stored.includes(foldApostrophes(partial))).toBe(true);
    }
  });
});

// The list description is the one field allowed to be more than one line: no editor
// anywhere in the app, and it arrives from a LighterPack import or a JSON backup.
// tidyText flattened it, which broke the round-trip and bought nothing on screen.
describe("tidyProse — the multi-line variant", () => {
  it("curls apostrophes, like everywhere else", () => {
    expect(tidyProse("Ryan's notes")).toBe(`Ryan${CURLY}s notes`);
  });

  it("keeps paragraphs exactly where the author put them", () => {
    const prose = "First para.\n\nSecond para, Ryan's notes.";
    expect(tidyProse(prose)).toBe(`First para.\n\nSecond para, Ryan${CURLY}s notes.`);
    expect(tidyProse(prose).split("\n").length).toBe(3);
  });

  it("collapses horizontal runs without touching the breaks", () => {
    expect(tidyProse("a   b\n\nc   d")).toBe("a b\n\nc d");
  });

  it("drops the spaces a wrapped source leaves hugging a line break", () => {
    expect(tidyProse("line one   \n   line two")).toBe("line one\nline two");
  });

  it("normalizes CRLF, so a Windows-authored backup doesn't double up", () => {
    expect(tidyProse("a\r\n\r\nb")).toBe("a\n\nb");
  });

  it("trims the whole value but not the interior", () => {
    expect(tidyProse("\n\n  Ryan's trip.\n\nDay two.  \n\n")).toBe(
      `Ryan${CURLY}s trip.\n\nDay two.`,
    );
  });

  it("still strips invisibles and keeps the joiners", () => {
    const ZWJ = String.fromCharCode(0x200d);
    expect(tidyProse(`Dup${ZWSP}lex`)).toBe("Duplex");
    expect(tidyProse(`a${ZWJ}b`)).toBe(`a${ZWJ}b`);
  });

  it("leaves measurements alone, same as tidyText", () => {
    expect(tidyProse(`Pitched with 6' guylines and 2" stakes.`)).toBe(
      `Pitched with 6' guylines and 2" stakes.`,
    );
  });

  it("is idempotent — it runs on every read too", () => {
    const prose = "First.\r\n\r\n  Ryan's second.  \n";
    expect(tidyProse(tidyProse(prose))).toBe(tidyProse(prose));
  });

  it("differs from tidyText in exactly one way: the line breaks survive", () => {
    const prose = "one\n\ntwo";
    expect(tidyText(prose)).toBe("one two"); // the flattening that was the problem
    expect(tidyProse(prose)).toBe("one\n\ntwo");
  });
});
