import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers/sources";

// THE LEGAL PAGE'S DATE MOVES WHEN ITS WORDS DO, AND ONLY THEN.
//
// The stamp ran on any staged change to the file, so a rename of CSS variables in the
// page's <style> block told readers the terms had changed two days after they last
// did. The script is a pre-commit hook, so it is run here the way git runs it: in a
// repository, against what is staged.
const SCRIPT = join(ROOT, "scripts/stamp-legal-dates.mjs");
const PAGE = "app/pages/legal.vue";
const page = (body: string, style: string, date = "July 12, 2026") =>
  `<template>\n  <main>\n    <p>Last updated ${date}</p>\n    <p>${body}</p>\n  </main>\n</template>\n\n<style scoped>\n.x { color: ${style}; }\n</style>\n`;

function repo(initial: string) {
  const dir = mkdtempSync(join(tmpdir(), "stamp-legal-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  mkdirSync(join(dir, "app/pages"), { recursive: true });
  const write = (source: string) => writeFileSync(join(dir, PAGE), source);
  write(initial);
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  return {
    /** Stage `source` and run the hook; returns the page as the commit would take it. */
    stage(source: string) {
      write(source);
      git("add", "-A");
      execFileSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
      return readFileSync(join(dir, PAGE), "utf8");
    },
  };
}

const today = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric" }).format(new Date());

describe("the legal page's date stamp", () => {
  it("leaves the date alone when only the page's styles change", () => {
    const r = repo(page("We keep nothing.", "var(--ink)"));
    expect(r.stage(page("We keep nothing.", "var(--foreground-primary)"))).toContain("Last updated July 12, 2026");
  });

  it("stamps today's date when the words change", () => {
    const r = repo(page("We keep nothing.", "var(--ink)"));
    expect(r.stage(page("We keep your email.", "var(--ink)"))).toContain(`Last updated ${today}`);
  });

  it("does not stamp over a date corrected by hand", () => {
    const r = repo(page("We keep nothing.", "var(--ink)", "July 14, 2026"));
    expect(r.stage(page("We keep nothing.", "var(--ink)", "July 12, 2026"))).toContain("Last updated July 12, 2026");
  });
});
