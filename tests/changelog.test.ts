// The changelog: unit-test the parser and the merge helper, and gate
// the committed fragments on what the parser cannot know (length, filename).
//
// Loading the fragments runs every one through parseChangelogRelease, so a malformed
// entry (bad date, empty group, blank bullet) fails this file before a test starts,
// the same way it would fail the release script.

import { describe, expect, it } from "vitest";
import {
  mergeReleases,
  parseChangelogRelease,
  readFragments,
  type ChangelogRelease,
} from "../scripts/changelogSources";

const fragments = readFragments();
const everything: ChangelogRelease[] = fragments.map((f) => f.release);

describe("parseChangelogRelease", () => {
  it("rejects rollover dates and malformed content before it reaches release rendering", () => {
    expect(() => parseChangelogRelease({ date: "2026-02-31", added: ["Impossible day."] }, "fixture")).toThrow(
      "real YYYY-MM-DD calendar date",
    );
    expect(() => parseChangelogRelease({ date: "2026-02-28", added: [" "] }, "fixture")).toThrow(
      'blank entry in "added"',
    );
    expect(() => parseChangelogRelease({ date: "2026-02-28", added: [] }, "fixture")).toThrow("needs at least one");
  });
});

describe("mergeReleases", () => {
  it("folds several fragments on one date into a single release, in input order", () => {
    const merged = mergeReleases([
      { date: "2026-07-01", added: ["one"] },
      { date: "2026-07-01", added: ["two"], fixed: ["three"] },
      { date: "2026-07-01", added: ["four"] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.added).toEqual(["one", "two", "four"]);
    expect(merged[0]?.fixed).toEqual(["three"]);
  });

  it("keeps distinct dates apart", () => {
    const merged = mergeReleases([
      { date: "2026-07-01", added: ["older"] },
      { date: "2026-07-09", added: ["newer"] },
      { date: "2026-07-01", added: ["older too"] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.date === "2026-07-01")?.added).toEqual(["older", "older too"]);
    expect(merged.find((r) => r.date === "2026-07-09")?.added).toEqual(["newer"]);
  });

  it("drops empty groups rather than carrying empty arrays into a release", () => {
    const merged = mergeReleases([{ date: "2026-07-01", added: ["one"], changed: [], fixed: [] }]);
    expect(merged[0]).toEqual({ date: "2026-07-01", added: ["one"] });
  });

  it("does not mutate the input or the releases inside it", () => {
    const input: ChangelogRelease[] = [
      { date: "2026-07-01", added: ["one"] },
      { date: "2026-07-01", added: ["two"] },
    ];
    mergeReleases(input);
    expect(input).toHaveLength(2);
    expect(input[0]?.added).toEqual(["one"]);
  });
});

describe("committed changelog content", () => {
  // 140 is room for one plain sentence with a clause, not two sentences: the
  // observable change, without the account of what it used to do.
  it("keeps every entry to one plain sentence (140 characters)", () => {
    const long: string[] = [];
    for (const rel of everything) {
      for (const group of [rel.added, rel.changed, rel.fixed]) {
        for (const entry of group ?? []) if (entry.length > 140) long.push(`${rel.date} [${entry.length}] ${entry}`);
      }
    }
    expect(long).toEqual([]);
  });

  it("names every fragment for the date it carries, so filename order is date order", () => {
    for (const f of fragments) {
      expect(f.name, `${f.name} does not start with its date`).toMatch(
        new RegExp(`^${f.release.date}-`),
      );
    }
  });
});
