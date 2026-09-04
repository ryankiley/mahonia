# Changelog fragments

One file per PR. Don't hand-write them — run:

```bash
npm run changelog -- --added "One plain sentence about the observable change."
```

Each file is a release object (`date`, optional `title`, and any of `added` / `changed` /
`fixed`), named `YYYY-MM-DD-<slug>-<hash>.json`. The name is fixed when the entry is written
and carries a hash of the content, so two branches can't land the same filename by accident
and the same set of files always folds into the same page.

**Why a directory and not one file.** Entries used to be appended to
`content/changelog.json` — every PR shipped on a given day edited the same release object at
the top of the same file, so any two open PRs conflicted on the same handful of lines. Two
PRs can't conflict on files neither of them shares. `shared/changelog.ts` has the long
version.

`scripts/build-changelog.ts` merges this directory with the `content/changelog.json` archive
into `content/changelog.generated.json` (generated, gitignored) before every dev, build,
generate, test and typecheck, and once at install. `npm run changelog:compact` folds settled fragments into the archive and
clears them out — housekeeping, never required.
