# Changelog fragments

One file per PR. Don't hand-write them — run:

```bash
npm run changelog -- --added "One plain sentence about the observable change."
```

Each file is a release object (`date` and any of `added` / `changed` / `fixed`), named
`YYYY-MM-DD-<slug>-<hash>.json`. The name is fixed when the entry is written and carries a
hash of the content, so two branches can't land the same filename by accident and the same
set of files always folds into the same release. The `YYYY-MM-DD-archive.json` files are the
days from before entries were one file per PR, a whole day each.

**Why a directory and not one file.** With every entry in one shared file, every PR shipped
on a given day edited the same release object at the top of it, so any two open PRs
conflicted on the same handful of lines. Two PRs can't conflict on files neither of them
shares. `scripts/changelogSources.ts` has the long version.

`scripts/release-notes.ts` reads this directory and hands each settled day to
`.github/workflows/releases.yml`, which publishes it as a GitHub Release.
