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
    // Several suites boot a WASM Postgres (PGlite) per file; on slow/cold CI
    // machines that routinely blows vitest's 5s default and fails as a spurious
    // "Test timed out". Raise both (hooks build the DBs) rather than disabling.
    // The Nuxt-environment file needs the same headroom for its app boot.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // CAP THE WORKERS, because the timeout above was only ever half the fix.
    //
    // A PGlite instance costs ~494 ms to boot and ~15 ms to take the schema
    // (measured — see tests/helpers/db.ts), and the suite boots ~96 of them. Those
    // are CPU-bound WASM starts, so vitest's default of one worker per core makes
    // them fight each other: on a 10-core machine a full run failed 12 files and
    // 117 tests, every one of them a 20s timeout in `beforeEach` and not a single
    // assertion failure, while the same suite at 4 workers passed 77/77 in 121s.
    // More workers past this point buys no wall-clock and starts inventing
    // failures, which on a 4-vCPU CI runner would be a red build nobody caused.
    //
    // The real fix is fewer boots (one instance per file, schema reset between
    // cases) — tests/helpers/db.ts is the seam for it and says what it would take.
    maxWorkers: 4,
  },
});
