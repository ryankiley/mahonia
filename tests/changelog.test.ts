// The "What's new" changelog: unit-test the ordering helper, and gate the
// committed content/changelog.json so a malformed entry (bad date, empty group,
// blank bullet) fails `npm test` instead of shipping to the page.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sortReleases, type ChangelogRelease } from "../shared/changelog";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const data = JSON.parse(
  readFileSync(join(root, "content/changelog.json"), "utf8"),
) as ChangelogRelease[];

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

describe("content/changelog.json", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("every release has an ISO date and at least one non-empty entry", () => {
    for (const rel of data) {
      expect(rel.date, JSON.stringify(rel)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const count = (rel.added?.length ?? 0) + (rel.changed?.length ?? 0) + (rel.fixed?.length ?? 0);
      expect(count, `no entries on ${rel.date}`).toBeGreaterThan(0);
    }
  });

  it("every entry is a non-blank string", () => {
    for (const rel of data) {
      for (const group of [rel.added, rel.changed, rel.fixed]) {
        for (const entry of group ?? []) {
          expect(typeof entry).toBe("string");
          expect(entry.trim().length, JSON.stringify(rel)).toBeGreaterThan(0);
        }
      }
    }
  });
});
