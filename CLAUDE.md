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

Safety net: if a user-facing PR merges without an entry, `changelog-backstop.yml` appends
the PR title verbatim after merge. Don't rely on it — a scraped title is the fallback, not
the standard. Catalog weight corrections are separate; they belong to `/changes`, not the
changelog.
