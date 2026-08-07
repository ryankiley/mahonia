import { describe, expect, it } from "vitest";
import { mergeSwitcherRows } from "../shared/switcher";

// The list switcher's merge: this browser's registry + the account's claimed
// lists, ONE ROW PER LIST. The rule under test is identity — a device row and a
// claimed row for the same list must collapse, and the device row must be the
// one left standing (its edit link works signed out and offline).

const device = (editToken: string, shareCode: string, slug: string, title: string) => ({
  editToken,
  shareCode,
  slug,
  title,
});
const claimed = (shareCode: string, slug: string, title: string) => ({ shareCode, slug, title });

describe("mergeSwitcherRows", () => {
  it("keeps device rows as edit links and claimed-only rows as code paths", () => {
    const rows = mergeSwitcherRows(
      [device("tok-a", "AAAA0000AAAA", "alpha-a1", "Alpha")],
      [claimed("BBBB0000BBBB", "beta-b1", "Beta")],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ key: "tok-a", to: "/e/AAAA0000AAAA#tok-a", shareCode: "AAAA0000AAAA" });
    expect(rows[1]).toMatchObject({ key: "code:BBBB0000BBBB", to: "/e/BBBB0000BBBB", title: "Beta" });
  });

  it("collapses the same list to its device row — the link this browser holds wins", () => {
    const rows = mergeSwitcherRows(
      [device("tok-a", "AAAA0000AAAA", "alpha-a1", "Alpha")],
      [claimed("AAAA0000AAAA", "alpha-a1", "Alpha")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("tok-a");
    expect(rows[0]!.to).toContain("#tok-a");
  });

  it("matches a legacy device row (no share code) to its claimed twin by slug", () => {
    // registry entries from before pretty links carry shareCode "" — without the
    // slug fallback the same pack would stand twice in the switcher
    const rows = mergeSwitcherRows(
      [device("tok-old", "", "sierra-x9y8z7", "Sierra")],
      [claimed("CCCC0000CCCC", "sierra-x9y8z7", "Sierra")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("tok-old");
    // the legacy row keeps its bare /e#{token} form until its next open heals it
    expect(rows[0]!.to).toBe("/e#tok-old");
  });

  it("never lets two codeless legacy rows shadow distinct claimed lists", () => {
    // "" shareCodes must not enter the held set — "" === "" would swallow every
    // claimed row at once
    const rows = mergeSwitcherRows(
      [device("tok-1", "", "one-aaa111", "One"), device("tok-2", "", "two-bbb222", "Two")],
      [claimed("DDDD0000DDDD", "three-ccc333", "Three")],
    );
    expect(rows.map((r) => r.key)).toEqual(["tok-1", "tok-2", "code:DDDD0000DDDD"]);
  });

  it("returns unsorted input order — display order belongs to the switcher", () => {
    const rows = mergeSwitcherRows(
      [device("tok-z", "ZZZZ0000ZZZZ", "zulu-z1", "Zulu"), device("tok-a", "AAAA0000AAAA", "alpha-a1", "Alpha")],
      [],
    );
    expect(rows.map((r) => r.key)).toEqual(["tok-z", "tok-a"]);
  });
});
