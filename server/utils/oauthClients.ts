// Who is asking: the OAuth clients the connector's sign-in will send a person back to.
//
// Two kinds, told apart by the shape of the client_id.
//
// A URL is a Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-
// document): the client hosts a JSON file naming itself, and the id IS the file's
// address. Claude's apps identify themselves this way, so nothing about Claude is
// registered or stored here; the document is fetched when a sign-in starts, checked,
// and remembered for a few minutes. That fetch takes a URL from a stranger, which is
// the shape of an SSRF, so it goes through the same guards the trail favicons use.
//
// Anything else is a client that registered itself at /register (RFC 7591), the path
// Cursor and ChatGPT take. Those rows live in oauth_clients.
//
// Either way a client is PUBLIC: it has no secret, and the proof that the party at
// the token endpoint is the one that started the sign-in is PKCE, not a password.

import { eq } from "drizzle-orm";
import { tidyText } from "../../shared/tidyText";
import { oauthClients } from "../db/schema";
import type { Db } from "./db";
import { readResponseCapped } from "./http";
import { safeGet, validateExternalUrl } from "./ssrf";
import { randomSecret } from "./tokens";

export interface OAuthClient {
  clientId: string;
  /** what the consent page shows. For a metadata document it is the host the
   *  document came from, because the document's own name is whatever the client
   *  chose to write in it; for a registered client it is the name it registered. */
  label: string;
  redirectUris: string[];
  kind: "document" | "registered";
}

/** registered client ids carry this, so the two kinds never need a lookup to tell apart */
export const REGISTERED_CLIENT_PREFIX = "mahonia_client_";

/** the document fetch: no redirects (a document that moves is a different document),
 *  the connector's agent string */
const FETCH = { maxRedirects: 0, timeoutMs: 5_000, headers: { accept: "application/json", "user-agent": "Mahonia connector/1.0 (+https://mahonia.app)" } };
const DOCUMENT_MAX_BYTES = 32_768;
/** how long a fetched document is believed before it is fetched again */
const DOCUMENT_CACHE_MS = 5 * 60_000;
const REDIRECT_URIS_MAX = 20;
const CLIENT_NAME_MAX = 100;

/** one process's memory of the documents it has read, by URL — a handful of entries
 *  in practice, capped so a flood of made-up client ids can't grow it */
const documents = new Map<string, { client: OAuthClient; at: number }>();
const DOCUMENTS_MAX = 64;

/** A string that could be a metadata document's address: https, with a path, and
 *  nothing in it that a fetch would act on (credentials, a fragment). */
function documentUrl(clientId: string): URL | null {
  if (!clientId.startsWith("https://") || clientId.length > 2_000) return null;
  const url = validateExternalUrl(clientId);
  if (!url || url.protocol !== "https:" || url.pathname === "/" || url.hash || url.href !== clientId) return null;
  return url;
}

/** The registered redirect URIs out of a document or a registration body: strings,
 *  parseable, https or loopback http, at most REDIRECT_URIS_MAX of them. */
export function cleanRedirectUris(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > REDIRECT_URIS_MAX) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || v.length > 2_000) return null;
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      return null;
    }
    if (url.hash || url.username || url.password) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return null;
    out.push(v);
  }
  return out;
}

export function cleanClientName(raw: unknown): string | null {
  return typeof raw === "string" ? tidyText(raw).slice(0, CLIENT_NAME_MAX) || null : null;
}

/**
 * Fetch and check a metadata document. The document must name itself by the exact
 * URL it was fetched from — that equality is what makes an address an identity — and
 * carry redirect URIs this server would accept. The fetch is the favicons' vetted
 * one (ssrf.ts), with no redirect hops allowed.
 */
async function fetchDocument(url: URL): Promise<OAuthClient | null> {
  const res = await safeGet(url, FETCH).catch(() => null);
  if (!res) return null;
  const read = await readResponseCapped(res, DOCUMENT_MAX_BYTES, "reject");
  if (!read.ok || !read.body) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(read.body.toString("utf8"));
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  if (d.client_id !== url.href) return null;
  const redirectUris = cleanRedirectUris(d.redirect_uris);
  if (!redirectUris) return null;
  return { clientId: url.href, label: url.host, redirectUris, kind: "document" };
}

/** The client behind a client_id, or null when there is none to be found. */
export async function resolveOAuthClient(db: Db, clientId: unknown): Promise<OAuthClient | null> {
  if (typeof clientId !== "string" || !clientId) return null;
  if (clientId.startsWith(REGISTERED_CLIENT_PREFIX)) {
    const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
    if (!row) return null;
    const redirectUris = cleanRedirectUris(JSON.parse(row.redirectUris));
    if (!redirectUris) return null;
    return { clientId, label: row.clientName ?? "a registered app", redirectUris, kind: "registered" };
  }
  const url = documentUrl(clientId);
  if (!url) return null;
  const known = documents.get(url.href);
  if (known && Date.now() - known.at < DOCUMENT_CACHE_MS) return known.client;
  const client = await fetchDocument(url);
  if (client) {
    if (documents.size >= DOCUMENTS_MAX) documents.delete(documents.keys().next().value!);
    documents.set(url.href, { client, at: Date.now() });
  }
  return client;
}

/** Forget the documents read so far — for tests that serve a different one. */
export function _forgetClientDocuments(): void {
  documents.clear();
}

/** Register a client (RFC 7591): a name and its redirect URIs, nothing secret. */
export async function registerOAuthClient(
  db: Db,
  input: { clientName: string | null; redirectUris: string[] },
): Promise<{ clientId: string; createdAt: Date }> {
  const clientId = REGISTERED_CLIENT_PREFIX + randomSecret();
  const [row] = await db
    .insert(oauthClients)
    .values({ clientId, clientName: input.clientName, redirectUris: JSON.stringify(input.redirectUris) })
    .returning();
  return { clientId, createdAt: row!.createdAt };
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/**
 * Whether a requested redirect URI is one the client registered. Exact, character
 * for character — except on a loopback address, where the port is the one thing a
 * native app can't know ahead of time (RFC 8252 §7.3): Claude Code binds a fresh
 * port each session and registered `http://localhost/callback`, so the port is left
 * out of the comparison there and nowhere else.
 */
export function redirectUriAllowed(requested: string, registered: readonly string[]): boolean {
  let want: URL;
  try {
    want = new URL(requested);
  } catch {
    return false;
  }
  if (want.hash || want.username || want.password) return false;
  const loopback = want.protocol === "http:" && isLoopbackHost(want.hostname);
  if (want.protocol !== "https:" && !loopback) return false;
  if (!loopback) return registered.includes(requested);
  return registered.some((r) => {
    let have: URL;
    try {
      have = new URL(r);
    } catch {
      return false;
    }
    return (
      have.protocol === "http:" &&
      isLoopbackHost(have.hostname) &&
      have.hostname.toLowerCase() === want.hostname.toLowerCase() &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}
