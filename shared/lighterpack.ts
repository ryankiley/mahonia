// Strict LighterPack share-URL parser. The host allowlist is the SECURITY
// BOUNDARY for the URL importer: the server only ever fetches
// lighterpack.com/csv/{id}, so the host is never user-controlled — only the
// external-id path segment, constrained here to a safe charset. Pure + shared so
// the client can use the same check to decide "this is a LighterPack link".
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The LighterPack external id from a share URL (/r|/csv|/e/{id}), or null. */
export function lighterpackId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "lighterpack.com") return null;
  const m = u.pathname.match(/^\/(?:r|csv|e)\/([^/]+)\/?$/);
  if (!m?.[1]) return null;
  // decodeURIComponent throws URIError on malformed percent-encoding (e.g. "%E0%A4%A");
  // a hostile/typo'd id must yield null (a clean 400), never an unhandled 500.
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return ID_RE.test(id) ? id : null;
}
