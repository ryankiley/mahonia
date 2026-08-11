// The "What's new" changelog: unit-test the ordering and merge helpers, and gate
// the committed content (archive + every fragment) so a malformed entry (bad
// date, empty group, blank bullet) fails `npm test` instead of shipping to the
// page.
//
// Reads the SOURCES, not content/changelog.generated.json — the generated file is
// a build artifact, and a test that only looked at it would pass on a stale build
// and fail on a clean checkout that hasn't built yet.

import { describe, expect, it } from "vitest";
import { readArchive, readFragments } from "../scripts/changelogSources";
import { mergeReleases, sortReleases, type ChangelogRelease } from "../shared/changelog";

const archive = readArchive();
const fragments = readFragments();
const everything: ChangelogRelease[] = [...archive, ...fragments.map((f) => f.release)];

describe("sortReleases", () => {
  it("orders newest date first", () => {
    const sorted = sortReleases([
      { date: "2026-06-27" },
      { date: "2026-07-16" },
      { date: "2026-07-10" },
    ]);
    expect(sorted.map((r) => r.date)).toEqual(["2026-07-16", "2026-07-10", "2026-06-27"]);
  });

  it("is stable within a date (keeps authored order) and does not mutate the input", () => {
    const input: ChangelogRelease[] = [
      { date: "2026-07-01", title: "a" },
      { date: "2026-07-01", title: "b" },
    ];
    const sorted = sortReleases(input);
    expect(sorted.map((r) => r.title)).toEqual(["a", "b"]);
    expect(input.map((r) => r.title)).toEqual(["a", "b"]); // untouched
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

  it("keeps distinct dates apart and sorts them newest first", () => {
    const merged = mergeReleases([
      { date: "2026-07-01", added: ["older"] },
      { date: "2026-07-09", added: ["newer"] },
      { date: "2026-07-01", added: ["older too"] },
    ]);
    expect(merged.map((r) => r.date)).toEqual(["2026-07-09", "2026-07-01"]);
    expect(merged[1]?.added).toEqual(["older", "older too"]);
  });

  it("takes the FIRST title on a date, so a shipped headline is not rewritten", () => {
    const merged = mergeReleases([
      { date: "2026-07-01", title: "Mahonia is live", added: ["one"] },
      { date: "2026-07-01", title: "second thoughts", added: ["two"] },
    ]);
    expect(merged[0]?.title).toBe("Mahonia is live");
  });

  it("carries a title through from a fragment when the archive has none", () => {
    const merged = mergeReleases([
      { date: "2026-07-01", added: ["one"] },
      { date: "2026-07-01", title: "Named later", added: ["two"] },
    ]);
    expect(merged[0]?.title).toBe("Named later");
  });

  it("drops empty groups rather than carrying empty arrays onto the page", () => {
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
  it("has a non-empty archive", () => {
    expect(Array.isArray(archive)).toBe(true);
    expect(archive.length).toBeGreaterThan(0);
  });

  it("every release has an ISO date and at least one non-empty entry", () => {
    for (const rel of everything) {
      expect(rel.date, JSON.stringify(rel)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const count = (rel.added?.length ?? 0) + (rel.changed?.length ?? 0) + (rel.fixed?.length ?? 0);
      expect(count, `no entries on ${rel.date}`).toBeGreaterThan(0);
    }
  });

  it("every entry is a non-blank string", () => {
    for (const rel of everything) {
      for (const group of [rel.added, rel.changed, rel.fixed]) {
        for (const entry of group ?? []) {
          expect(typeof entry).toBe("string");
          expect(entry.trim().length, JSON.stringify(rel)).toBeGreaterThan(0);
        }
      }
    }
  });

  it("names every fragment for the date it carries, so filename order is date order", () => {
    for (const f of fragments) {
      expect(f.name, `${f.name} does not start with its date`).toMatch(
        new RegExp(`^${f.release.date}-`),
      );
    }
  });

  it("folds cleanly — one release per date, newest first", () => {
    const merged = mergeReleases(everything);
    const dates = merged.map((r) => r.date);
    expect(new Set(dates).size, "a date appears twice after merging").toBe(dates.length);
    expect([...dates].sort((a, b) => b.localeCompare(a))).toEqual(dates);
  });
});
