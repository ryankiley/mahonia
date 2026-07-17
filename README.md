# Mahonia

A no-login gear-list and pack-weight tracker for hikers. Make a packing list, see what it
weighs, share it — no account, no app.

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

## Stack

[Nuxt 4](https://nuxt.com) · Vue 3 · TypeScript · [Drizzle ORM](https://orm.drizzle.team) ·
deployed on [Vercel](https://vercel.com).

## Changelog

The site's [“What’s new”](https://mahonia.app/changelog) page renders
[`content/changelog.json`](content/changelog.json) — the one source of truth. When a change is
user-facing, add a plain one- or two-sentence entry as part of the same PR:

```bash
npm run changelog -- --added "Sort folders by weight."
npm run changelog -- --fixed "…" --changed "…"
```

Entries are grouped Added / Changed / Fixed and describe the observable change, not the
implementation.

Two workflows keep the page honest: a PR comment reminds any user-facing PR that's missing
an entry, and if one merges anyway, a backstop appends the PR title to the changelog after
merge (rough but never silent). Label a PR **`skip-changelog`** to opt out of both. A
hand-written entry in the PR always beats the scraped title.

## License

Code is [MIT](LICENSE). The gear catalog data under `seed/` is licensed separately — see
[`seed/LICENSE.md`](seed/LICENSE.md).
