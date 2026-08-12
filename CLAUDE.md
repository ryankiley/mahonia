# Mahonia — session rules

The README covers setup and stack. These are the working rules for changes in this repo.

## Every user-facing PR ships a changelog entry

If the PR changes something a visitor can notice (almost anything touching `app/` or
`shared/`), add an entry to the on-site "What's new" page **in the same PR**:

```bash
npm run changelog -- --added "One plain sentence about the observable change."
```

`--added` / `--changed` / `--fixed`, repeatable. House style: plain, user-facing, the
observable behavior — never the implementation. See existing entries in
`content/changelog.json` for the voice.

That command writes a **new file** under `content/changelog.d/`, one per PR, so two open
PRs can never conflict over it. `content/changelog.json` is the archive — don't hand-edit
it; `npm run changelog:compact` folds settled fragments in, occasionally, on its own PR.
The build merges both into `content/changelog.generated.json`, which is generated and not
checked in. See `shared/changelog.ts`.

Not user-facing (refactor, deps, infra, catalog data)? Prefix the PR title —
`refactor:`, `chore:`, `ci:`, `test:`, `docs:`, `perf:` — or put the `skip-changelog`
label on it. Either silences the reminder; the prefix needs no trip to the GitHub UI.

Nothing auto-fills this. A `changelog-reminder` comment nudges any user-facing PR that's
missing an entry, but if one merges without it, the "What's new" page simply omits that
change until it's backfilled by hand. Writing the entry as part of the PR is the whole job.
Catalog weight corrections are separate; they belong to `/changes`, not the changelog.
