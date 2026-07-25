import { defineVitestConfig } from "@nuxt/test-utils/config";

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
    // Several suites boot a WASM Postgres (PGlite) per file; on slow/cold CI
    // machines that routinely blows vitest's 5s default and fails as a spurious
    // "Test timed out". Raise both (hooks build the DBs) rather than disabling.
    // The Nuxt-environment file needs the same headroom for its app boot.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
