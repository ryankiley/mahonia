import { defineVitestConfig } from "@nuxt/test-utils/config";
import { defaultExclude } from "vitest/config";

// Most suites here are framework-agnostic plain TS (shared/ logic, server/ repos
// against PGlite) and keep running in the default node environment — fast, no Nuxt
// boot. That was the whole point of the previous plain `defineConfig`, and it still
// holds.
//
// defineVitestConfig only makes the Nuxt environment AVAILABLE; it does not impose
// it. A file opts in with `// @vitest-environment nuxt` on its first line, which
// boots a Nuxt app for that file alone. Only tests that genuinely need the framework
// — auto-imports, composables holding Vue reactivity — should opt in; everything
// else stays on node. See tests/gearList.nuxt.test.ts for the one case that does,
// and the comment there for why it can't be tested as plain TS.
export default defineVitestConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // A git WORKTREE lives at .claude/worktrees/<name>/ — a second full checkout of
    // this repo, nested inside it. Its tests/ answers the include above, so a run
    // from the main checkout collected every worktree's copy of the suite too: 110
    // files instead of 81, and 122 "failures" that were only stale checkouts whose
    // Nuxt environment no longer resolves. Nothing about the working tree was
    // wrong, which is what made it cost an afternoon — a red run that looks exactly
    // like a regression and isn't. CI never sees it (fresh clone, no worktrees).
    //
    // defaultExclude is spread back in because naming `exclude` REPLACES vitest's
    // own list rather than extending it — drop it and node_modules is walked again.
    exclude: [...defaultExclude, "**/.claude/**"],
    // The Nuxt-environment files boot an app each, and cold CI machines are slow;
    // vitest's 5s default routinely failed those as a spurious "Test timed out".
    // Raise both (hooks build the DBs) rather than disabling. The DB-backed files
    // used to be the ones that hit this first — a PGlite boot per case, ~460 ms of
    // CPU-bound WASM start each, fighting one another across workers — until
    // tests/helpers/db.ts went to one boot per file; a full run is now 120 files in
    // ~75 s on a 10-core machine at moderate load, none of it near this limit.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // CAP THE WORKERS. Four rather than one per core, for two reasons that both
    // outlive the PGlite contention this was first added for (a 10-core run at the
    // default failed 117 tests, every one a timeout, while 4 workers passed them all):
    // CI's runner has four vCPUs, so a higher cap buys nothing where the full suite
    // actually runs; and locally this machine is shared with other sessions' suites
    // and Ryan's own work — see "Checking a change" in CLAUDE.md for why a full local
    // run is the exception now, not the routine.
    maxWorkers: 4,
  },
});
