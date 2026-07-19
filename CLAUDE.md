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

Not user-facing (refactor, deps, infra, catalog data)? Put the `skip-changelog` label on
the PR.

Nothing auto-fills this — there's no backstop that scrapes the PR title. A
`changelog-reminder` comment nudges any user-facing PR that's missing an entry, but if one
merges without it, the "What's new" page simply omits that change until it's backfilled by
hand. Writing the entry as part of the PR is the whole job. Catalog weight corrections are
separate; they belong to `/changes`, not the changelog.
