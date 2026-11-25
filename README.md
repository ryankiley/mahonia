# Mahonia

A gear-list and pack-weight tracker for hikers. Make a packing list, see what it weighs,
share it.

Lists need no sign-up: one is yours the moment you start typing, held by a private
unguessable link. **My Gear** is the one part that asks for an account, because
"the gear I own" has to follow you across devices rather than living in one browser.

## What it does

- **Pack weight:** base, worn and consumable totals, with a carried figure. Weights are
  optional.
- **A cited gear catalog** behind the autocomplete, every value overridable per row.
- **Per-row units:** type `32.5 oz` on a gram list and that row keeps ounces.
- **Calories** on consumables, and **trip dates** as plain calendar dates.
- **Two share links:** read-only, and an edit link for co-planning that can be replaced.
- **Packing mode:** the same list as a checklist.
- **My Gear:** the gear you own, one pick away on the next list.
- **Import** from LighterPack or a JSON backup; **export** as CSV, JSON or Markdown.
- **Recovery points:** the server keeps the last few versions of every list.

## Run locally

Requires **Node 26** (see `.nvmrc`).

```bash
npm install
npm run seed   # load the gear catalog into a local database
npm run dev    # http://localhost:3000
```

With no environment variables set, the app runs fully on your machine against a local
[PGlite](https://github.com/electric-sql/pglite) database, and sign-in links and feedback
print to the server console instead of being sent. For a production deploy, copy
`.env.example` to `.env`; it documents each variable.

## Stack

[Nuxt 4](https://nuxt.com) · Vue 3 · TypeScript · [Drizzle ORM](https://orm.drizzle.team) ·
[Neon](https://neon.tech) Postgres · deployed on [Vercel](https://vercel.com).

## MCP connector

The app serves a remote MCP server at `https://mahonia.app/mcp`, so an AI assistant can use
Mahonia as a connector with nothing to install:

| Tool | What it does |
| --- | --- |
| `get_list` | Reads a list from its share link, as data or Markdown. |
| `search_catalog` | Searches the gear catalog, or returns one product's variants. |
| `create_list` | Makes a list and returns its share and edit links. |
| `edit_list` | Makes every change to a list in one call, given its edit link. |
| `get_my_gear`, `edit_my_gear` | Read and change My Gear. |

The list tools need no sign-in: the links are the permission. My Gear and an account's own
lists need a sign-in, which Claude offers on the first call that asks for one, or a token
from `/account` sent as an `Authorization: Bearer` header. The server is hand-rolled in
`server/routes/mcp.post.ts`, `server/utils/mcp.ts` and `server/utils/oauth.ts`, which carry
the reasoning.

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=mahonia&config=eyJ1cmwiOiJodHRwczovL21haG9uaWEuYXBwL21jcCJ9)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=mahonia&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmahonia.app%2Fmcp%22%7D)

- **Claude:** [add Mahonia as a connector](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Mahonia&connectorUrl=https%3A%2F%2Fmahonia.app%2Fmcp)
  and choose "Sign in when needed".
- **Claude Code:** `claude mcp add --transport http --scope user mahonia https://mahonia.app/mcp`,
  then `/mcp` to sign in when a gear tool asks.
- **An `mcp.json`:** `{"mcpServers":{"mahonia":{"url":"https://mahonia.app/mcp"}}}`
- **ChatGPT, Gemini CLI, stdio clients:** see [Help](https://mahonia.app/help).

The [MCP registry](https://registry.modelcontextprotocol.io) lists it as
`app.mahonia/mahonia`, from [`server.json`](server.json). The registry never reads this repo:
once a listing change is on `main`, run `mcp-publisher login dns` then
`mcp-publisher publish`.

## Changelog

The changelog is [GitHub Releases](https://github.com/ryankiley/mahonia/releases), one per
day that ships something. A user-facing PR adds its own one-sentence entry;
[`CLAUDE.md`](CLAUDE.md) has the rules.

```bash
npm run changelog -- --added "Sort folders by weight."
```

## License

Code is [MIT](LICENSE). The gear catalog data under `seed/` is licensed separately (see
[`seed/LICENSE.md`](seed/LICENSE.md)), and the interface icons in
`app/utils/centralIcons.ts` are [central icons](https://iconists.co/central) under the
[iconists license](https://iconists.co/license), not MIT. Notices for the libraries bundled
into the client are in [`public/licenses.txt`](public/licenses.txt).
