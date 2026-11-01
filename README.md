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

## MCP connector

The app serves a remote MCP server at `/mcp`, so an AI assistant can be handed
`https://mahonia.app/mcp` as a connector with nothing to install. Six tools, kept few on
purpose so a connector shows a short permission list. Four need no sign-in: `get_list`
reads a shared list as data or Markdown, `search_catalog` searches the cited gear catalog
or returns one product's variants, `create_list` makes a list, and `edit_list`, holding an
edit link, makes every change to an existing one in a single call: the list's title, dates
and trail, its folders, new rows (into a folder, or nested under a group), changes to the
rows already there (fields, folder, place, group, and the catalog link, relinked in
place), and removals. Rows nest one level deep, as the site's groups do: `get_list` shows
a group as a row with items, `create_list` takes the same shape, and `edit_list` nests a
row under a parent by id. `get_list` gives every row and folder an id for those edits, and
reads from an edit link too, by the share code in its address. A share code is the read
capability and the edit link's fragment token the write one, hashed on arrival and passed
only as a tool argument, so nothing new is trusted. The transport is stateless JSON-RPC
over POST (MCP revisions 2025-06-18 and 2025-11-25, no sessions, no event stream, GET
answers 405), hand-rolled in `server/routes/mcp.post.ts` with the tools in
`server/utils/mcp.ts`; both files carry the reasoning.

Two more tools, and one more use of `get_list`, reach an **account**. `get_list` with no
share code names the lists filed under it, each by its share code, so an assistant can
open one without being handed a link, and with read-and-change access `edit_list` takes
that share code in place of the edit link, resolved through the same claim the site uses
when a signed-in owner edits a list, so the edit token still never leaves the server.
`get_my_gear` and `edit_my_gear` read and change **My Gear**, and can link a piece to the
catalog, as it is added or later. An account's lists and its gear belong to the account
rather than a link, so
these need the account behind the call, and there are two ways to give it. In Claude, add
the URL as a connector and choose "Sign in when needed": the first call to an account tool
shows a Connect card, you sign in to Mahonia with your passkey or a link, allow read or
read-and-change, and the call goes through. That is OAuth 2.1 with Mahonia as its own
authorization server (discovery under `/.well-known`, `/authorize`, `/token`, `/revoke`,
`/register`; PKCE S256; Client ID Metadata Documents, so Claude registers nothing;
hour-long access tokens with rotating refresh tokens; `server/utils/oauth.ts` and
`server/utils/oauthClients.ts` carry the reasoning). A client configured from a file takes
a token minted under Assistant access on `/account` instead, sent as `Authorization:
Bearer <token>`. Either way only hashes are stored, the credential reaches the account's
filed lists and its gear and nothing more, and it lasts until it is revoked on that page
or by "Sign out everywhere". With read-and-change, `create_list` also files the list it
makes under the account, as a signed-in browser files the lists it creates, and reports
`saved_to_account`.

The gate is at the door, as Claude requires: a `tools/call` naming an account tool with no
valid bearer answers 401 with a `WWW-Authenticate` header that points at the discovery
document and names the scope the tool needs, and a read-only bearer on a tool that changes
gear or a list answers 403 with `insufficient_scope`. `edit_list` called with an edit link
and `get_list` called with a share code are not account tools; the same tools without
one are. `initialize`, `tools/list` and the four list tools never ask for a credential
on their own, so a connector added with no sign-in works exactly as before.

Add it to a client:

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=mahonia&config=eyJ1cmwiOiJodHRwczovL21haG9uaWEuYXBwL21jcCJ9)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=mahonia&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmahonia.app%2Fmcp%22%7D)

- **Claude** (claude.ai, Desktop, mobile): [add Mahonia as a connector](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Mahonia&connectorUrl=https%3A%2F%2Fmahonia.app%2Fmcp)
  and choose "Sign in when needed". Lists and the catalog work at once; the first My Gear
  call asks you to sign in. Connectors added there are available in Claude Code too.
- **Claude Code:** `claude mcp add --transport http --scope user mahonia https://mahonia.app/mcp`,
  then `/mcp` to sign in when a gear tool asks, or add
  `--header "Authorization: Bearer <token>"` to skip the sign-in with a token from `/account`
  (the page prints the line with your token in it).
- **Gemini CLI:** `gemini mcp add --transport http mahonia https://mahonia.app/mcp` (`-H "Authorization: Bearer <token>"` for My Gear)
- **ChatGPT:** Settings, Developer mode, add `https://mahonia.app/mcp` with "No Authentication".
- **Anything that reads an `mcp.json`:** `{"mcpServers":{"mahonia":{"url":"https://mahonia.app/mcp"}}}`,
  plus `"headers":{"Authorization":"Bearer <token>"}` for My Gear.
- **A client that only speaks stdio:** bridge with `npx mcp-remote https://mahonia.app/mcp`
  (`--header "Authorization: Bearer <token>"` for My Gear).

The server is listed in the [official MCP registry](https://registry.modelcontextprotocol.io)
as `app.mahonia/mahonia`; [`server.json`](server.json) is the listing, published with
`mcp-publisher` under the domain's DNS proof.

## Changelog

The changelog is [GitHub Releases](https://github.com/ryankiley/mahonia/releases): one release
per day that ships something, tagged by date (`v2026.09.12`), cut by a workflow from the entries
below. When a change is user-facing, add a plain one-sentence entry as part of the same PR:

```bash
npm run changelog -- --added "Sort folders by weight."
npm run changelog -- --fixed "…" --changed "…"
```

Entries are grouped Added / Changed / Fixed and describe the observable change, not the
implementation.

Each run writes its own file under `content/changelog.d/`, so entries from PRs open at the
same time never collide — [`content/changelog.json`](content/changelog.json) is the settled
archive, and `npm run changelog:compact` folds fragments into it now and then. Once a day is
over (Pacific), `.github/workflows/releases.yml` turns it into a release; a late entry updates
its day's notes.

A PR comment reminds any user-facing PR that's missing an entry — but nothing auto-fills it,
so the entry is always hand-written (plain, curated prose). If a PR merges
without one, that day's release just omits the change until it's backfilled. For non-user-facing work,
prefix the PR title (`refactor:`, `chore:`, `ci:`, `test:`, `docs:`, `build:`) or label it
**`skip-changelog`** — `perf:` and `style:` don't count, since both are things a visitor notices.

## License

Code is [MIT](LICENSE). The gear catalog data under `seed/` is licensed separately — see
[`seed/LICENSE.md`](seed/LICENSE.md).

Third-party notices for the libraries bundled into the client are in
[`public/licenses.txt`](public/licenses.txt), served at `/licenses.txt`. The file exists
because Mahonia bundles its dependencies instead of loading them from a CDN (a CDN
`<script>` could read a list's edit token out of `location.hash`), which makes serving the
site a redistribution of that code — and the minifier strips the banner comments those
libraries ship their copyright in. Add an entry when a dependency's code starts reaching
the browser; server-only packages aren't redistributed and aren't listed.
