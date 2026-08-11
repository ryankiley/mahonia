# Mahonia

A gear-list and pack-weight tracker for hikers. Make a packing list, see what it weighs,
share it.

Lists need no sign-up: one is yours the moment you start typing, held by a private
unguessable link. The **gear vault** is the one part that asks for an account, because
"the gear I own" has to follow you across devices rather than living in one browser.

## What it does

- **Weigh a pack.** Base, worn and consumable totals, with the worn split (three pairs of
  socks, one on your feet) and a carried figure. Weights are optional — a list with none
  keeps its totals quiet.
- **A curated gear catalog** behind the autocomplete, cited and correctable, with every
  value overridable per row.
- **Per-row units.** Type `32.5 oz` on a gram list and that row keeps ounces while the
  total stays in grams.
- **Calories** on consumables, totalled for the list.
- **Trip dates**, as calendar dates — no time, no timezone, so a trip doesn't shift when
  you fly.
- **Share two ways:** a read-only link, and an edit link for co-planning. Either can be
  replaced if it gets out.
- **Packing mode** — the same list as a checklist, for the night before.
- **A gear vault** that fills itself as you build, so your kit is one pick away next time.
- **Import** from LighterPack (share link or CSV) or a JSON backup; **export** as CSV,
  JSON or Markdown.
- **Recovery points**, so an accidental delete is undoable well after the toast.

## Run locally

Requires **Node 24** (the pinned version — see `.nvmrc`).

```bash
npm install
npm run seed   # load the gear catalog into a local database
npm run dev    # http://localhost:3000
```

With no environment variables set, the app runs fully on your machine against a local
[PGlite](https://github.com/electric-sql/pglite) database. Copy `.env.example` to `.env` to
point at a real Postgres ([Neon](https://neon.tech)) and Redis ([Upstash](https://upstash.com))
for a production deploy.

Anything that would leave the machine degrades to the console instead of being skipped, so
a fresh checkout is a working app rather than a broken one:

| Unset variable | What happens locally |
| --- | --- |
| `RESEND_API_KEY` | Sign-in links print to the server console instead of being emailed. |
| `GITHUB_FEEDBACK_TOKEN` / `_REPO` | "Send feedback" (in the editor's actions menu) prints to the console and reports back that it wasn't filed. |

Both fail **loudly in production** rather than quietly accepting input that goes nowhere.

## Stack

[Nuxt 4](https://nuxt.com) · Vue 3 · TypeScript · [Drizzle ORM](https://orm.drizzle.team) ·
deployed on [Vercel](https://vercel.com).

## Changelog

The site's [“What’s new”](https://mahonia.app/about#whats-new) section (on the About page) renders
the changelog. When a change is user-facing, add a plain one- or two-sentence entry as part of
the same PR:

```bash
npm run changelog -- --added "Sort folders by weight."
npm run changelog -- --fixed "…" --changed "…"
```

Entries are grouped Added / Changed / Fixed and describe the observable change, not the
implementation.

Each run writes its own file under `content/changelog.d/`, so entries from PRs open at the
same time never collide — [`content/changelog.json`](content/changelog.json) is the settled
archive, and `npm run changelog:compact` folds fragments into it now and then. The build
merges the two into `content/changelog.generated.json` (generated, not checked in), which is
what the page reads.

A PR comment reminds any user-facing PR that's missing an entry — but nothing auto-fills it,
so the entry is always hand-written (the page stays plain, curated prose). If a PR merges
without one, the page just omits that change until it's backfilled. For non-user-facing work,
prefix the PR title (`refactor:`, `chore:`, `ci:`, `test:`, `docs:`, `perf:`) or label it
**`skip-changelog`**.

## License

Code is [MIT](LICENSE). The gear catalog data under `seed/` is licensed separately — see
[`seed/LICENSE.md`](seed/LICENSE.md).
