// Where `npm run mirror` finds its input, and what it must not run beside.
//
// The config and the gear file name a real account, so they are gitignored, and a
// fresh worktree has neither. They are kept once, in the main checkout's seed/_mirror,
// and every worktree reads that copy unless it has its own (a different account for
// one test) or MAHONIA_MIRROR_DIR names another folder.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const MIRROR_CONFIG = "mirror.json";

/**
 * The folder holding mirror.json, or every place looked when none does. In the order
 * they win: the override, this checkout's seed/_mirror, the main checkout's. The main
 * checkout is found through git's common dir, which in a linked worktree is the main
 * checkout's .git (and in the main checkout is its own, naming this checkout again).
 */
export function findMirrorDir(opts: {
  override?: string;
  root: string;
  /** `git rev-parse --git-common-dir`, absolute. */
  commonDir?: string;
  exists: (path: string) => boolean;
}): { dir: string } | { looked: string[] } {
  const own = join(opts.root, "seed", "_mirror");
  const main = opts.commonDir && basename(opts.commonDir) === ".git" ? join(dirname(opts.commonDir), "seed", "_mirror") : undefined;
  const candidates = opts.override ? [resolve(opts.root, opts.override)] : main && main !== own ? [own, main] : [own];
  const dir = candidates.find((d) => opts.exists(join(d, MIRROR_CONFIG)));
  return dir ? { dir } : { looked: candidates.map((d) => join(d, MIRROR_CONFIG)) };
}

/** This checkout's git common dir, absolute; undefined outside a git checkout. */
export function gitCommonDir(root: string): string | undefined {
  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" });
  return git.status === 0 ? git.stdout.trim() || undefined : undefined;
}

/**
 * The pids of dev servers (nuxt dev or preview) running from `cwd`. Each holds the
 * PGlite folder there open, and PGlite is one process at a time: a second writer
 * beside it loses its writes or worse. Empty where ps or lsof can't say.
 */
export function devServersIn(cwd: string): number[] {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const pids = (ps.stdout ?? "").split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    // the command itself (`…/.bin/nuxt dev`), not any line that mentions nuxt and
    // later says dev: a shell running `grep nuxt … </dev/null` would pass that
    return m && /(?:^|[\s/])nux[ti]\s+(?:dev|preview)(?:\s|$)/.test(m[2]) ? [m[1]] : [];
  });
  if (!pids.length) return [];
  const here = realpathSync(cwd);
  // -Fpn: one "p<pid>" line, then one "n<path>" line for its working directory
  const lsof = spawnSync("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { encoding: "utf8" });
  const held: number[] = [];
  let pid = 0;
  for (const line of (lsof.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && line.slice(1) === here) held.push(pid);
  }
  return held;
}
