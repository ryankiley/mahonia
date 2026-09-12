import { defineEventHandler, getQuery, setHeader } from "h3";
import changelog from "../../content/changelog.generated.json";
import { sortReleases, type ChangelogRelease } from "../../shared/changelog";

// The "What's new" feed, served rather than imported.
//
// content/changelog.json used to be a module-scope `import` in the page that renders it,
// which bundled every entry into that route's CLIENT chunk (~3 KB brotli and climbing).
// It only ever grows: the house rule is an entry per user-facing PR, so the JS a build
// emits crept upward on changes that ship no code at all — and it counted against the
// bundle budget even though nobody but a visitor to that page downloads it.
//
// Reading it here keeps it in the server bundle. /about is prerendered, so Nitro
// calls this at BUILD time and bakes the result into the page's HTML + payload: no
// function invocation for a normal visit, and the client chunk carries the renderer
// only, never the content. Mirrors /changes, which already reads its feed this way.
//
// The import is the GENERATED file — the archive and content/changelog.d/*.json
// folded into one by scripts/build-changelog.ts, which every `pre` hook runs, so
// it is always there and always current before this module is loaded. Entries are
// authored one file per PR; shared/changelog.ts says why.
//
// The Added/Changed/Fixed flattening lives here too — dropping empty groups server-side
// means the template just iterates, and the payload doesn't carry empty arrays.
//
// `?limit=N` returns the newest N releases. /about asks for one: it shows the latest
// as a taste of /changelog, and the whole log is fifty kilobytes a prerendered page
// would otherwise carry in its payload for a visitor who came to read what Mahonia is.
const GROUP_DEFS = [
  { key: "added", label: "Added" },
  { key: "changed", label: "Changed" },
  { key: "fixed", label: "Fixed" },
] as const;

export interface ChangelogGroup {
  label: string;
  items: string[];
}
export interface ChangelogEntry {
  date: string;
  title?: string;
  groups: ChangelogGroup[];
}

export default defineEventHandler((event) => {
  // Checked-in content that only changes on deploy — cache hard at the edge. (No
  // rate limit, unlike /changes: this reads no database and does no per-request work.)
  setHeader(event, "Cache-Control", "public, max-age=300, s-maxage=3600");
  const limit = Number(getQuery(event).limit);
  const sorted = sortReleases(changelog as ChangelogRelease[]);
  const shown = Number.isInteger(limit) && limit > 0 ? sorted.slice(0, limit) : sorted;
  const releases: ChangelogEntry[] = shown.map((rel) => ({
    date: rel.date,
    title: rel.title,
    groups: GROUP_DEFS.map((g) => ({ label: g.label, items: rel[g.key] ?? [] })).filter(
      (g) => g.items.length > 0,
    ),
  }));
  return { releases };
});
