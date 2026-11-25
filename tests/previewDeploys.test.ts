import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOT } from "./helpers/sources";

// Preview deploys and the Neon branch limit are one decision, and this file is what
// keeps them together.
//
// Every preview deploy makes the Neon integration create a `preview/<git-branch>`
// database branch, and Neon does not delete it when the git branch merges. The Free
// plan allows ten. When they filled (2026-09-12) the next preview failed with
// "Resource provisioning failed", a 0 ms build and no logs, and nothing in the
// failure named Neon. A workflow, .github/workflows/neon-cleanup.yml, swept them on
// every PR close and nightly.
//
// Since then only `main` deploys (vercel.json), so nothing creates those branches and
// the workflow was removed with nothing left to delete. That is safe for exactly as
// long as previews stay off. Turning them back on without the sweep refills the limit
// in about a day of ordinary PRs, so it has to be one change: restore the workflow
// (`git log --diff-filter=D -- .github/workflows/neon-cleanup.yml` finds it) in the PR
// that enables previews, and this test passes again.

const vercel = JSON.parse(readFileSync(`${ROOT}vercel.json`, "utf8")) as {
  git?: { deploymentEnabled?: boolean | Record<string, boolean> };
};

/** The git branches vercel.json lets deploy, other than main. Empty means previews are off. */
function previewBranches(): string[] {
  const enabled = vercel.git?.deploymentEnabled;
  // absent, or `true`, is Vercel's default: every branch deploys
  if (enabled === undefined || enabled === true) return ["**"];
  if (enabled === false) return [];
  // a pattern left out of the map deploys too, so the catch-all must be there and off
  const on = Object.entries(enabled).filter(([pattern, value]) => value && pattern !== "main").map(([pattern]) => pattern);
  return enabled["**"] === false ? on : ["**", ...on];
}

describe("preview deploys and Neon's branch limit", () => {
  it("either no branch but main deploys, or the Neon branch sweep is in place", () => {
    const sweep = existsSync(`${ROOT}.github/workflows/neon-cleanup.yml`);
    expect(
      previewBranches().length === 0 || sweep,
      `vercel.json lets ${previewBranches().join(", ")} deploy as previews, and each one creates a Neon branch that nothing deletes. Restore .github/workflows/neon-cleanup.yml in this change.`,
    ).toBe(true);
  });
});
