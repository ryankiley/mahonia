# Mahonia — session rules

The README covers setup and stack. These are the working rules for changes in this repo.

## Every user-facing PR ships a changelog entry

If the PR changes something a visitor can notice (almost anything touching `app/` or
`shared/`), add a changelog entry **in the same PR**. The changelog is published as a
GitHub Release per day that ships something (`.github/workflows/releases.yml`); the site
does not render it.

```bash
npm run changelog -- --added "One plain sentence about the observable change."
```

`--added` / `--changed` / `--fixed`, repeatable. House style: plain, user-facing, the
observable behavior — never the implementation. See existing entries in
`content/changelog.json` for the voice.

That command writes a **new file** under `content/changelog.d/`, one per PR, so two open
PRs can never conflict over it. `content/changelog.json` is the archive — don't hand-edit
it; `npm run changelog:compact` folds settled fragments in, occasionally, on its own PR.
See `shared/changelog.ts`.

Not user-facing (refactor, deps, infra, catalog data)? Prefix the PR title —
`refactor:`, `chore:`, `ci:`, `test:`, `docs:`, `perf:` — or put the `skip-changelog`
label on it. Either silences the reminder; the prefix needs no trip to the GitHub UI.

Nothing auto-fills this. A `changelog-reminder` comment nudges any user-facing PR that's
missing an entry, but if one merges without it, that day's release simply omits the change
until it's backfilled by hand. Writing the entry as part of the PR is the whole job.
Catalog weight corrections are separate; they belong to `/changes`, not the changelog.

## Checking a change: CI is the gate; locally, run what you touched

CI (`.github/workflows/ci.yml`) runs the typecheck, the whole suite, the build and the
bundle budget on every PR, and `main` requires that `check` to pass before anything merges.
So the full suite and the full typecheck are not a step to run here before opening a PR —
they are what the PR runs, on a machine nobody is waiting at. Locally, run what the change
touches:

```bash
npm run test:changed
```

That is `vitest run --changed origin/main`: every test whose import graph reaches a file
changed on this branch, committed or not. Or name the files — `npx vitest run
tests/water.test.ts`. The typecheck is cheap enough to run whole — `npm run typecheck` is
the three projects side by side, incremental, ~6 s warm — or one of them: `npm run
typecheck -- app` (`scripts`, `tests`).

Why this matters more here than the habit suggests: several sessions share this machine,
each in its own worktree. Two full suites running at once starve each other into 20 s
timeouts that look exactly like regressions (vitest.config.ts has the history), and the
typecheck that takes 19 s alone measured 92 s beside them. A full local run is for a change
to the harness itself — vitest.config.ts, tests/helpers, scripts/typecheck.mjs — where
"which tests" has no narrower answer; run it alone, when `uptime` says the machine is quiet.

Then open the PR and let it merge itself on green: `gh pr merge --auto --squash`. A red
check is yours to fix; the desktop app's PR pane and `gh pr checks --watch` both show it.

## Catalog conventions are enforced, not described

Adding or editing rows in `seed/_research/*.json`: the naming, size, unit, food-weight and
citation conventions are all build ERRORS — `npm test` runs `scripts/catalogChecks.ts` over the
built CSV and `scripts/researchChecks.ts` over the research rows, and CI runs `npm test` on every
PR. Read the rules on `ResearchRow` in `scripts/research.ts`; `npm run catalog:audit` prints the
same findings with the row named. The only warnings are to-do lists for a human (weight
plausibility, pouch meals still at net weight, tents still at trail weight, food rows without kcal,
rows missing an axis their gear type is sold by). `catalog:build` also fails on a
`seed/common-names.json` entry that matches no row.

A tent row stores the maker's packaged weight (stakes and bags included), never the trail or
minimum figure; a row that could only be sourced at trail weight says `trail weight` in its variant.

A variant's axes are read out of it at build time into the CSV's `attributes` column
(`scripts/catalogAttributes.ts`; the vocabulary and what each gear type is sold by live in
`shared/catalogAxes.ts`). A research row writes in `attributes` only what its variant doesn't state
(an R-value, a quilt's rating), in the canonical form; a value that contradicts the variant, a
variant that claims one axis twice, or a value outside its form is a build error. A value read from
a page other than the row's own cites it with `attributes_source_url` + `attributes_quote` (the kcal
bar); an axis the maker was found not to publish is recorded in `attributes_unpublished` so the
audit's to-do list names only unread rows.

