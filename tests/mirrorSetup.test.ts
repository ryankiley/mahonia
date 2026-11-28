import { describe, expect, it } from "vitest";
import { findMirrorDir } from "../scripts/mirrorSetup";

// Where `npm run mirror` reads its config. A fresh worktree has no seed/_mirror (it is
// gitignored, it names an account), so it must find the main checkout's copy on its
// own, or every session starts from nothing and reaches for the real site instead.
const MAIN = "/repo";
const TREE = "/repo/.claude/worktrees/feature";
const has = (...configs: string[]) => (path: string) => configs.includes(path);

describe("findMirrorDir", () => {
  it("in a worktree with none of its own, reads the main checkout's", () => {
    const found = findMirrorDir({ root: TREE, commonDir: `${MAIN}/.git`, exists: has(`${MAIN}/seed/_mirror/mirror.json`) });
    expect(found).toEqual({ dir: `${MAIN}/seed/_mirror` });
  });

  it("prefers the worktree's own config to the shared one", () => {
    const found = findMirrorDir({
      root: TREE,
      commonDir: `${MAIN}/.git`,
      exists: has(`${TREE}/seed/_mirror/mirror.json`, `${MAIN}/seed/_mirror/mirror.json`),
    });
    expect(found).toEqual({ dir: `${TREE}/seed/_mirror` });
  });

  it("takes MAHONIA_MIRROR_DIR over both, relative to the checkout", () => {
    const found = findMirrorDir({
      override: "../elsewhere",
      root: TREE,
      commonDir: `${MAIN}/.git`,
      exists: has(`${TREE}/seed/_mirror/mirror.json`, "/repo/.claude/worktrees/elsewhere/mirror.json"),
    });
    expect(found).toEqual({ dir: "/repo/.claude/worktrees/elsewhere" });
  });

  it("names every place it looked when none has a config, each once", () => {
    expect(findMirrorDir({ root: TREE, commonDir: `${MAIN}/.git`, exists: has() })).toEqual({
      looked: [`${TREE}/seed/_mirror/mirror.json`, `${MAIN}/seed/_mirror/mirror.json`],
    });
    // the main checkout's common dir is its own .git: one place, not the same one twice
    expect(findMirrorDir({ root: MAIN, commonDir: `${MAIN}/.git`, exists: has() })).toEqual({
      looked: [`${MAIN}/seed/_mirror/mirror.json`],
    });
  });

  it("doesn't guess a main checkout from a common dir that isn't a .git folder", () => {
    // a bare repository's worktrees: the common dir IS the repository, with no checkout beside it
    expect(findMirrorDir({ root: TREE, commonDir: "/srv/repo.git", exists: has("/srv/seed/_mirror/mirror.json") })).toEqual({
      looked: [`${TREE}/seed/_mirror/mirror.json`],
    });
  });
});
