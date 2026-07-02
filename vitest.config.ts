import { defineConfig } from "vitest/config";

// shared/ logic is framework-agnostic plain TS — tested without a Nuxt env.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Several suites boot a WASM Postgres (PGlite) per file; on slow/cold CI
    // machines that routinely blows vitest's 5s default and fails as a spurious
    // "Test timed out". Raise both (hooks build the DBs) rather than disabling.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
