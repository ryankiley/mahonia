import { describe, expect, it } from "vitest";
import { normalizeTrailUrl, parseTrailLink, safeUrl } from "../shared/trailLink";

describe("safeUrl", () => {
  it("accepts http and https", () => {
    expect(safeUrl("https://www.alltrails.com/trail/x")?.protocol).toBe("https:");
    expect(safeUrl("http://example.com")?.protocol).toBe("http:");
  });

  it("rejects the schemes that execute when bound to :href", () => {
    // Vue doesn't sanitize attribute bindings — these would run on click
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("rejects unparseable and empty input", () => {
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl("")).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
});

describe("normalizeTrailUrl", () => {
  it("returns the canonical href, so what's stored is already render-safe", () => {
    expect(normalizeTrailUrl("https://example.com")).toBe("https://example.com/");
  });

  it("returns null for anything unsafe, so the reducer can reject it", () => {
    expect(normalizeTrailUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeTrailUrl("   ")).toBeNull();
  });
});

describe("parseTrailLink — name derivation", () => {
  // The corpus this was tuned against. The point of keeping it as one table is that
  // the LONG TAIL keeps degrading gracefully as the rules get tuned: every row either
  // reads like a real name or falls back to the bare hostname. Neither column may ever
  // contain a mangled name — that's the regression this table exists to catch.
  const DERIVES: [url: string, name: string][] = [
    // the headline case: AllTrails slugs are more descriptive than most og:titles
    [
      "https://www.alltrails.com/trail/us/california/mount-tamalpais-east-peak-via-verna-dunshee-trail",
      "Mount Tamalpais East Peak via Verna Dunshee Trail",
    ],
    // --N is AllTrails' same-name disambiguator, not part of the name
    ["https://www.alltrails.com/trail/us/washington/mount-si-trail--2", "Mount Si Trail"],
    // two tokens — the "atypical site" floor; a 3-token rule would lose WTA entirely
    ["https://www.wta.org/go-hiking/hikes/rattlesnake-ledge", "Rattlesnake Ledge"],
    ["https://www.wta.org/go-hiking/hikes/enchantments-traverse", "Enchantments Traverse"],
    // underscores are just as common a separator as hyphens
    ["https://www.oregonhikers.org/field_guide/Dog_Mountain_Hike", "Dog Mountain Hike"],
    // trailing numeric id — the walk falls back a segment instead of giving up
    ["https://www.summitpost.org/mount-si/150340", "Mount Si"],
    // id in the MIDDLE of the path, name last
    ["https://www.hikingproject.com/trail/7002176/mount-si-trail", "Mount Si Trail"],
    ["https://www.trailforks.com/trails/whistler-downhill/", "Whistler Downhill"],
    // not a trail site at all — a forum trip report still reads fine
    [
      "https://www.reddit.com/r/WildernessBackpacking/comments/abc123/trip_report_enchantments/",
      "Trip Report Enchantments",
    ],
    ["https://someblog.example/2024/07/enchantments-thru-hike/", "Enchantments Thru Hike"],
    // ALL-CAPS slugs are normalized, not shouted back
    ["https://www.alltrails.com/TRAIL/US/CA/MOUNT-SI-TRAIL", "Mount Si Trail"],
    // query + fragment are ignored: only pathname is read
    [
      "https://alltrails.com/trail/us/california/half-dome-via-the-mist-trail?u=i&sh=abc#reviews",
      "Half Dome via the Mist Trail",
    ],
  ];

  it.each(DERIVES)("derives a name from %s", (url, expected) => {
    expect(parseTrailLink(url)?.name).toBe(expected);
  });

  const FALLS_BACK: [url: string, host: string][] = [
    ["https://caltopo.com/m/ABC12", "caltopo.com"], // opaque short id
    ["https://www.komoot.com/tour/1234567", "komoot.com"], // numeric id only
    ["https://www.strava.com/routes/3216549870", "strava.com"],
    ["https://www.gaiagps.com/datasummary/a1b2c3d4e5f6/", "gaiagps.com"], // hash-ish
    ["https://peakbagger.com/climber/peak.aspx?pid=2036", "peakbagger.com"], // name is in the query
    ["https://www.14ers.com/route.php?route=gray1", "14ers.com"],
    // single token: "Mistrail" would be a misreading of "Mist Trail" — decline instead
    ["https://www.nps.gov/yose/planyourvisit/mistrail.htm", "nps.gov"],
    ["https://sierraclub.org/outings", "sierraclub.org"],
    ["https://example.com/", "example.com"],
  ];

  it.each(FALLS_BACK)("falls back to the hostname for %s", (url, host) => {
    const link = parseTrailLink(url);
    expect(link?.name).toBe(host);
    expect(link?.host).toBe(host);
  });

  it("never lets a non-Latin script be mistaken for an id", () => {
    // The "no vowels ⇒ probably a hash" check is Latin-only by design. Ungated it
    // would collapse every Japanese/Greek/Cyrillic trail name to a bare hostname.
    expect(parseTrailLink("https://www.yamap.com/courses/富士山-吉田ルート")?.name).toBe(
      "富士山 吉田ルート",
    );
  });

  it("carries accented and percent-encoded names through intact", () => {
    // The small-word list is English-only, so "am"/"und" title-case here rather than
    // staying lowercase as they would in German prose. That's a deliberate limit, not
    // a bug: the name is still correct and readable, and the alternative is carrying a
    // per-language stopword list for a field the owner can override with a label.
    expect(
      parseTrailLink("https://www.komoot.de/tour/wanderung-am-k%C3%B6nigssee-und-malerwinkel")
        ?.name,
    ).toBe("Wanderung Am Königssee Und Malerwinkel");
    expect(
      parseTrailLink("https://es.wikiloc.com/rutas-senderismo/subida-al-pico-de-la-maliciosa")
        ?.name,
    ).toBe("Subida Al Pico De La Maliciosa");
  });

  it("skips a segment whose percent-encoding is malformed", () => {
    // decodeURIComponent throws on this; rendering the raw "%E0%A4%A" in a trail
    // name is worse than showing the hostname
    expect(parseTrailLink("https://bad.example/trail/%E0%A4%A-broken-encoding")?.name).toBe(
      "bad.example",
    );
  });

  it("truncates a long name on a word boundary", () => {
    const url = "https://long.example/trail/" + "north-cascades-boston-basin-climbers-approach-and-return-via-cascade-river-road";
    const name = parseTrailLink(url)!.name;
    expect(name.length).toBeLessThanOrEqual(73); // 72 + the ellipsis
    expect(name.endsWith("…")).toBe(true);
    expect(name).not.toMatch(/ …$/); // trimmed, not left dangling after a space
  });

  it("discards an absurdly long slug rather than truncating junk", () => {
    const slug = "a-really-quite-extraordinarily-verbose-and-overlong-trail-name".repeat(4);
    expect(parseTrailLink(`https://long.example/trail/${slug}`)?.name).toBe("long.example");
  });

  it("skips path furniture so it can't become the name", () => {
    // …/trail/7002176 has no real name anywhere — "Trail" is not an answer
    expect(parseTrailLink("https://www.hikingproject.com/trail/7002176")?.name).toBe(
      "hikingproject.com",
    );
  });
});

describe("parseTrailLink — label and href", () => {
  it("prefers the owner's label over anything derived", () => {
    const link = parseTrailLink(
      "https://www.alltrails.com/trail/us/washington/mount-si-trail",
      "Si with the dog",
    );
    expect(link?.name).toBe("Si with the dog");
  });

  it("ignores a blank or whitespace-only label", () => {
    const url = "https://www.wta.org/go-hiking/hikes/rattlesnake-ledge";
    expect(parseTrailLink(url, "   ")?.name).toBe("Rattlesnake Ledge");
    expect(parseTrailLink(url, "")?.name).toBe("Rattlesnake Ledge");
    expect(parseTrailLink(url, null)?.name).toBe("Rattlesnake Ledge");
  });

  it("falls back to the hostname when a label can't rescue an opaque URL", () => {
    expect(parseTrailLink("https://caltopo.com/m/ABC12", "Enchantments route")?.name).toBe(
      "Enchantments route",
    );
  });

  it("returns null for an unsafe URL even when a label is supplied", () => {
    // a label must never be enough to get an unrenderable href onto a shared page
    expect(parseTrailLink("javascript:alert(1)", "Totally a trail")).toBeNull();
  });

  it("exposes a normalized href and a www-stripped host", () => {
    const link = parseTrailLink("https://www.alltrails.com/trail/us/washington/mount-si-trail");
    expect(link?.host).toBe("alltrails.com");
    expect(link?.href).toBe("https://www.alltrails.com/trail/us/washington/mount-si-trail");
  });
});
