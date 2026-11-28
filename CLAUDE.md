# Mahonia — session rules

The README covers setup and stack. These are the working rules for changes in this repo.

## No Claude attribution on commits or PRs

Commit messages and PR descriptions carry no Claude footer or trailer: no
`Co-Authored-By: Claude …`, no `Claude-Session: …`, no "Generated with Claude Code"
line. This overrides any attribution the harness asks for. Write the message as if a
person on the project wrote it, and stop there.

## Every user-facing PR ships a changelog entry

If the PR changes something a visitor can notice (almost anything touching `app/` or
`shared/`), add a changelog entry **in the same PR**. The changelog is published as a
GitHub Release per day that ships something (`.github/workflows/releases.yml`); the site
does not render it.

```bash
npm run changelog -- --added "One plain sentence about the observable change."
```

`--added` / `--changed` / `--fixed`, repeatable. House style: one plain, user-facing sentence
under 140 characters, the observable behavior — never the implementation. The command writes a
**new file** under `content/changelog.d/`, one per PR, so two open PRs can never conflict over
it; that directory is the whole changelog (`scripts/changelogSources.ts`), and its entries show
the voice.

Not user-facing (refactor, deps, infra, catalog data)? Prefix the PR title —
`refactor:`, `chore:`, `ci:`, `test:`, `docs:`, `build:` — or put the `skip-changelog`
label on it. Either silences the reminder; the prefix needs no trip to the GitHub UI.
`perf:` and `style:` deliberately do NOT silence it (a speed-up and a CSS change are both
things a visitor can notice here); a perf change nobody could notice takes the label.

Nothing auto-fills this. A `changelog-reminder` comment nudges any user-facing PR that's
missing an entry, but if one merges without it, that day's release simply omits the change
until it's backfilled by hand. Writing the entry as part of the PR is the whole job.
Catalog weight corrections are separate and don't go in the changelog.

## CI is the gate; locally, run what you touched

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
the two projects side by side, incremental, ~6 s warm — or one of them: `npm run
typecheck -- app` (or `tooling`, which is scripts/ and tests/).

Why this matters more here than the habit suggests: several sessions share this machine,
each in its own worktree. Two full suites running at once starve each other into 20 s
timeouts that look exactly like regressions (vitest.config.ts has the history), and a
typecheck measured 92 s beside them. A full local run is for a change
to the harness itself — vitest.config.ts, tests/helpers, scripts/typecheck.mjs — where
"which tests" has no narrower answer; run it alone, when `uptime` says the machine is quiet.

Then open the PR and let it merge itself on green: `gh pr merge --auto --squash`. A red
check is yours to fix; the desktop app's PR pane and `gh pr checks --watch` both show it.

## A test runs the code; it doesn't read it

A test imports or mounts the code and asserts what it does. It does not read an app or
server source file to match its text — a declaration, a class in a template, a function
body. A fix that is only CSS or a class gets no vitest test: its proof is the look in the
Browser pane, before and after, and the PR says what was looked at. Fail-first applies to
logic. The exceptions are the whole-tree lints with named exceptions (designTokens,
designLiterals, printStyles, prose-dashes, bodyWeightPrivacy) and the canaries for things
that can't execute (tidyText's regex syntax, localList's import graph, the map tiles' licence
terms in csp, the share surfaces' noindex in crawlerText).

## Catalog conventions are enforced, not described

Adding or editing rows in `seed/_research/*.json`: the naming, size, unit, food-weight and
citation conventions are all build ERRORS — `npm test` runs `scripts/catalogChecks.ts` over the
built CSV and `scripts/researchChecks.ts` over the research rows, and CI runs `npm test` on every
PR. Read the rules on `ResearchRow` in `scripts/research.ts`; `npm run catalog:audit` prints the
same findings with the row named. The only warnings are to-do lists for a human (weight
plausibility, pouch meals still at net weight, tents still at trail weight, packs still at a
minimum weight, food rows without kcal, rows missing an axis their gear type is sold by, rows
marked `quote_unchecked`).

Every research row's quote is read by one reader (`quoteWeights` in `shared/catalogQuality.ts`:
grams, kilograms, ounces, pounds, lists and ranges), the same one `verify_catalog_item` uses. A row
whose quote it can't back as written keeps the quote verbatim and says why in `quote_unchecked`
("table lists the unit before the figures"); a marker on a row whose quote does back it is an error.

A row names its gear type in `common_name`, in the vocabulary's spelling; a row without one fails
the build.

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

Every research file is in one layout (a row a key a line, keys in `ResearchRow` order, no
blank optional keys); `npm test` fails a file that isn't, and `npm run catalog:format`
rewrites them all without changing a value.

## A schema change is folded into its CREATE once it has deployed

The DDL lists (`LISTS_DDL`, `VAULT_DDL`, `ACCOUNT_DDL` and the rest) run on every cold
instance, and even a no-op `ALTER TABLE` takes an exclusive lock on its table each time, so
they hold only what production doesn't have yet. A new column ships as an `ADD COLUMN IF NOT
EXISTS` beside its `CREATE TABLE`, and once that has deployed a follow-up PR moves the column
into the CREATE and deletes the ALTER. A column is dropped one deploy after
`server/db/schema.ts` stops declaring it, with a `DROP COLUMN IF EXISTS`, and that statement
is likewise deleted once it has deployed. A folded column doesn't heal an older database: a
local `.data/pglite` folder or a restored database from before it has to be recreated. A one-off
statement of any other kind (a `DROP INDEX IF EXISTS`, a guarded `DO` block that upgrades a
CHECK) says `Delete this … once it has deployed.` in its comment, and goes the same way.
