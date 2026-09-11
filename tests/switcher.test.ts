import { describe, expect, it } from "vitest";
import { mergeSwitcherRows, resumeTarget } from "../shared/switcher";

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

describe("resumeTarget — where the bare address lands", () => {
  const row = (editToken: string, shareCode: string, lastOpened: number) => ({ editToken, shareCode, lastOpened });
  const open = (shareCode: string, lastOpened: number) => ({ shareCode, lastOpened });

  it("picks the list opened most recently, as its edit link", () => {
    const t = resumeTarget([row("tokA", "AAAA", 100), row("tokB", "BBBB", 300), row("tokC", "CCCC", 200)]);
    expect(t).toEqual({ to: "/e/BBBB#tokB", shareCode: "BBBB" });
  });

  it("is null with no lists, and skips a row that carries no edit token", () => {
    expect(resumeTarget([])).toBeNull();
    expect(resumeTarget([row("", "AAAA", 900)])).toBeNull();
  });

  it("keeps registry order on a tie, so an entry from before the field still resolves", () => {
    const t = resumeTarget([row("tokA", "AAAA", 0), { editToken: "tokB", shareCode: "BBBB", lastOpened: undefined as unknown as number }]);
    expect(t?.shareCode).toBe("AAAA");
  });

  // The bug this half exists for: a list made on another device reaches this one as
  // a CLAIMED row, and opening it leaves no registry entry — so the bare address,
  // which is the installed app's start_url and therefore every offline launch, used
  // to hand back whatever older list happened to hold a token here.
  it("resumes a claimed open that is newer than every list this browser holds", () => {
    const t = resumeTarget([row("tokA", "AAAA", 100), row("tokB", "BBBB", 200)], [open("CCCC", 300)]);
    expect(t).toEqual({ to: "/e/CCCC", shareCode: "CCCC" });
  });

  it("still prefers a token when the token is the more recent open", () => {
    const t = resumeTarget([row("tokA", "AAAA", 400)], [open("CCCC", 300)]);
    expect(t).toEqual({ to: "/e/AAAA#tokA", shareCode: "AAAA" });
  });

  it("takes the edit link for a list that is in both, whichever side is newer", () => {
    // the token works signed out and offline, so it is the better way into the same
    // list — and the registry row's own lastOpened already covers those opens
    expect(resumeTarget([row("tokA", "AAAA", 100)], [open("AAAA", 900)])).toEqual({
      to: "/e/AAAA#tokA",
      shareCode: "AAAA",
    });
  });

  it("resumes a claimed open with nothing in the registry at all", () => {
    expect(resumeTarget([], [open("CCCC", 5)])).toEqual({ to: "/e/CCCC", shareCode: "CCCC" });
  });

  it("lets a token win a dead heat with a claimed open", () => {
    const t = resumeTarget([row("tokA", "AAAA", 300)], [open("CCCC", 300)]);
    expect(t?.shareCode).toBe("AAAA");
  });

  it("ignores a claimed entry with no share code", () => {
    expect(resumeTarget([], [open("", 900)])).toBeNull();
  });
});
