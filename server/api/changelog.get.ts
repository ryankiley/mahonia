import { defineEventHandler, setHeader } from "h3";
import changelog from "../../content/changelog.json";
import { sortReleases, type ChangelogRelease } from "../../shared/changelog";

// The "What's new" feed, served rather than imported.
//
// content/changelog.json used to be a module-scope `import` in app/pages/changelog.vue,
// which bundled every entry into that route's CLIENT chunk (~3 KB brotli and climbing).
// It only ever grows: the house rule is an entry per user-facing PR, so the JS a build
// emits crept upward on changes that ship no code at all — and it counted against the
// bundle budget even though nobody but a /changelog visitor downloads it.
//
// Reading it here keeps it in the server bundle. /changelog is prerendered, so Nitro
// calls this at BUILD time and bakes the result into the page's HTML + payload: no
// function invocation for a normal visit, and the client chunk carries the renderer
// only, never the content. Mirrors /changes, which already reads its feed this way.
//
// The Added/Changed/Fixed flattening lives here too — dropping empty groups server-side
// means the template just iterates, and the payload doesn't carry empty arrays.
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
  const releases: ChangelogEntry[] = sortReleases(changelog as ChangelogRelease[]).map((rel) => ({
    date: rel.date,
    title: rel.title,
    groups: GROUP_DEFS.map((g) => ({ label: g.label, items: rel[g.key] ?? [] })).filter(
      (g) => g.items.length > 0,
    ),
  }));
  return { releases };
});
