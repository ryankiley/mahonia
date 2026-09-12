// A GitHub Release per changelog date — the pure half (scripts/releaseNotes.ts). The
// workflow's git and gh calls are not tested; what is tested is that a day becomes the
// right tag, the right title, the right body, and only once the day is over.
import { describe, expect, it } from "vitest";
import type { ChangelogRelease } from "../shared/changelog";
import { releaseBody, releaseTitle, settledReleases, tagFor, todayIn } from "../scripts/releaseNotes";

const day = (date: string, extra: Partial<ChangelogRelease> = {}): ChangelogRelease => ({ date, ...extra });

describe("release tags", () => {
  it("are the date in CalVer", () => {
    expect(tagFor("2026-09-12")).toBe("v2026.09.12");
  });

  it("sort the way the dates do", () => {
    const tags = ["2026-09-12", "2026-06-27", "2026-12-01"].map(tagFor).sort();
    expect(tags).toEqual(["v2026.06.27", "v2026.09.12", "v2026.12.01"]);
  });
});

describe("settled releases", () => {
  it("are the days strictly before today, oldest first", () => {
    const rels = [day("2026-09-12"), day("2026-09-10"), day("2026-09-11")];
    expect(settledReleases(rels, "2026-09-12").map((r) => r.date)).toEqual(["2026-09-10", "2026-09-11"]);
  });

  it("hold today back — its entries are still being written", () => {
    expect(settledReleases([day("2026-09-12")], "2026-09-12")).toEqual([]);
  });

  it("read today in the changelog's own timezone", () => {
    // 06:30 UTC on the 13th is still the evening of the 12th in Portland
    expect(todayIn("America/Los_Angeles", new Date("2026-09-13T06:30:00Z"))).toBe("2026-09-12");
    expect(todayIn("UTC", new Date("2026-09-13T06:30:00Z"))).toBe("2026-09-13");
  });
});

describe("release title and body", () => {
  it("print the date the way the site does, with the day's headline if it has one", () => {
    expect(releaseTitle(day("2026-09-12"))).toBe("September 12, 2026");
    expect(releaseTitle(day("2026-06-27", { title: "Mahonia is live" }))).toBe("June 27, 2026: Mahonia is live");
  });

  it("group the entries Added / Changed / Fixed and skip an empty group", () => {
    const body = releaseBody(day("2026-09-12", { added: ["A thing."], fixed: ["A bug.", "Another."] }));
    expect(body).toBe(
      "### Added\n\n- A thing.\n\n### Fixed\n\n- A bug.\n- Another.\n\n[What's new](https://mahonia.app/changelog) on the site has every release.\n",
    );
    expect(body).not.toContain("Changed");
  });
});
