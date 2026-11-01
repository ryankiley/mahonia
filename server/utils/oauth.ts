// Signing in to the connector: Mahonia as an OAuth 2.1 authorization server for its
// own MCP endpoint.
//
// The hand-minted token (accessTokens.ts) is the right credential for a client that
// is configured from a file. Claude's apps are not configured from a file: a person
// adds a URL, and the first time Claude reaches a tool that needs their account it
// shows them a Connect card and opens a sign-in. What that card needs from us is
// exactly the MCP authorization spec (2025-11-25), and in a few places Claude's
// stricter reading of it, which this file follows to the letter where it matters:
//
//   - the refusal that starts sign-in is an HTTP 401 with a WWW-Authenticate header
//     naming our protected-resource document, issued by the route BEFORE a tool runs
//     (mcp.post.ts); a 200 carrying an error is a tool failure, not a sign-in
//   - discovery is two JSON documents under /.well-known, and ours advertises the
//     pair Claude requires before it will identify itself with a metadata document
//     rather than registering: client_id_metadata_document_supported and "none"
//     among token_endpoint_auth_methods_supported
//   - every client is public, so PKCE (S256, nothing else) is what binds the token
//     request to the sign-in, and the refresh token rotates on every use
//   - access tokens last an hour and are refreshed; the refresh token lasts until
//     the person revokes the app on their account page
//
// Nothing here is a JWT. Every token is an opaque random value stored as sha256,
// like a session, a magic link and a hand-minted token (accessTokens.ts holds them
// all), so a dump of these tables yields nothing that can be presented anywhere.

import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { H3Event } from "h3";
import { getHeader, readRawBody, setHeader, setResponseStatus } from "h3";
import type { AccessScope } from "../../shared/types";
import { oauthCodes } from "../db/schema";
import { connectorToken, isAccessScope, resolveBearer, type ConnectorIdentity } from "./accessTokens";
import { useAccountDb, type Db } from "./db";
import { readJsonBodyCapped, setNoStore } from "./http";
import { redirectUriAllowed, resolveOAuthClient, type OAuthClient } from "./oauthClients";
import { trustedOrigin } from "./origin";
import { randomSecret, sha256Hex } from "./tokens";

declare module "h3" {
  interface H3EventContext {
    /** what the MCP route found behind the request's bearer, for the tools: an
     *  account, null for a bearer that opens nothing, unset when none was carried */
    connector?: ConnectorIdentity | null;
  }
}

// ---- scopes ---------------------------------------------------------------------

/** What a client may ask for. `read` and `write` are the two levels at the gear
 *  tools, and `write` includes `read`: there is no way to change gear you can't see.
 *  `offline_access` is the word Claude adds to ask for a refresh token; every grant
 *  gets one, so the word is accepted and changes nothing. */
const SCOPES_SUPPORTED = ["read", "write", "offline_access"] as const;

/** A scope string as a client sends it, as the level it grants, or null when it names
 *  a scope this server doesn't have. Empty means read. */
export function scopeFromRequest(raw: unknown): AccessScope | null {
  if (raw === undefined || raw === null || raw === "") return "read";
  if (typeof raw !== "string" || raw.length > 200) return null;
  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.every((w) => (SCOPES_SUPPORTED as readonly string[]).includes(w))) return null;
  return words.includes("write") ? "write" : "read";
}

// ---- the endpoint's own addresses -------------------------------------------------

/** The MCP endpoint as a resource identifier (RFC 8707): what tokens are issued for,
 *  and what a client's `resource` parameter has to say. */
export const mcpResource = (origin: string) => `${origin}/mcp`;

/** RFC 9728: who issues tokens for /mcp, and what they can ask for. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: ["read", "write"],
    bearer_methods_supported: ["header"],
    resource_name: "Mahonia",
  };
}

/** RFC 8414: where the sign-in lives and what it speaks. The two lines Claude reads
 *  before it will use its metadata document instead of registering are
 *  client_id_metadata_document_supported and "none" in the auth methods. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    revocation_endpoint: `${origin}/revoke`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: SCOPES_SUPPORTED,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
  };
}

// ---- PKCE -------------------------------------------------------------------------

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export const isCodeVerifier = (v: unknown): v is string => typeof v === "string" && VERIFIER_RE.test(v);
const isCodeChallenge = (v: unknown): v is string => typeof v === "string" && CHALLENGE_RE.test(v);

/** S256: the challenge a verifier proves. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ---- the authorization request ------------------------------------------------------

/** How long Allow's code stays redeemable. The client redeems it the moment the
 *  redirect lands; a minute covers a slow network and nothing more. */
const CODE_TTL_MS = 60_000;

const STATE_MAX = 1_024;

type AuthorizeCheck =
  | { ok: true; client: OAuthClient; redirectUri: string; state: string | null; scope: AccessScope; codeChallenge: string }
  | {
      ok: false;
      error: string;
      description: string;
      /** where to send the user agent with the error, once the client and its
       *  redirect URI have checked out; null before that, when the only safe answer
       *  is a page that says so */
      redirect: string | null;
      /** the client, once it has checked out, for the page to judge the redirect by */
      client?: OAuthClient;
    };

/**
 * Check an authorization request the way the spec orders it: first the client and
 * its redirect URI, which must be right before anything is sent back through them;
 * then everything else, whose failures travel to the client as error redirects.
 */
export async function checkAuthorizeRequest(db: Db, origin: string, q: Record<string, unknown>): Promise<AuthorizeCheck> {
  const str = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : undefined);
  const refuse = (error: string, description: string, redirect: string | null = null, client?: OAuthClient): AuthorizeCheck => ({ ok: false, error, description, redirect, client });

  const client = await resolveOAuthClient(db, str("client_id"));
  if (!client) return refuse("invalid_client", "That client_id names no client this server knows.");
  const redirectUri = str("redirect_uri");
  if (!redirectUri || !redirectUriAllowed(redirectUri, client.redirectUris)) {
    return refuse("invalid_request", "That redirect_uri is not one the client registered.");
  }
  const state = str("state") ?? null;
  if (state !== null && state.length > STATE_MAX) return refuse("invalid_request", "state is too long.");
  const back = (error: string, description: string) => refuse(error, description, errorRedirect(redirectUri, error, description, state), client);

  if (str("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  const codeChallenge = str("code_challenge");
  if (!isCodeChallenge(codeChallenge)) return back("invalid_request", "A code_challenge is required (PKCE, S256).");
  if (str("code_challenge_method") !== "S256") return back("invalid_request", "code_challenge_method must be S256.");
  const scope = scopeFromRequest(str("scope"));
  if (!scope) return back("invalid_scope", "This server grants read, write and offline_access.");
  const resource = str("resource");
  if (resource !== undefined && resource !== mcpResource(origin)) return back("invalid_target", `Tokens here are for ${mcpResource(origin)}.`);
  return { ok: true, client, redirectUri, state, scope, codeChallenge };
}

/** The redirect URI with the client's parameters added to its query — never to a
 *  fragment, never replacing what the URI already carried. */
export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.href;
}

export function errorRedirect(redirectUri: string, error: string, description: string, state: string | null): string {
  return redirectWith(redirectUri, { error, error_description: description, state });
}

/** Allow: mint the code the client will trade for tokens. Raw value returned, hash kept. */
export async function mintAuthCode(
  db: Db,
  grant: { userId: number; client: OAuthClient; redirectUri: string; codeChallenge: string; scope: AccessScope },
): Promise<string> {
  const code = randomSecret();
  await db.insert(oauthCodes).values({
    codeHash: sha256Hex(code),
    userId: grant.userId,
    clientId: grant.client.clientId,
    clientName: grant.client.label,
    redirectUri: grant.redirectUri,
    codeChallenge: grant.codeChallenge,
    scope: grant.scope,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return code;
}

/**
 * Spend a code. The consumed stamp is written in the same statement that finds the
 * row, so two token requests racing with one code can't both succeed: the second
 * matches nothing. An expired code matches nothing either. The scope comes back as
 * the level it is, or the row is treated as unusable.
 */
export async function redeemAuthCode(db: Db, raw: unknown): Promise<(typeof oauthCodes.$inferSelect & { scope: AccessScope }) | null> {
  if (typeof raw !== "string" || !raw || raw.length > 200) return null;
  const now = new Date();
  const [row] = await db
    .update(oauthCodes)
    .set({ consumedAt: now })
    .where(and(eq(oauthCodes.codeHash, sha256Hex(raw)), isNull(oauthCodes.consumedAt), gt(oauthCodes.expiresAt, now)))
    .returning();
  return row && isAccessScope(row.scope) ? { ...row, scope: row.scope } : null;
}

// ---- who is calling /mcp ----------------------------------------------------------------

/** The request's connector identity, or null; `carried` says whether a bearer of ours
 *  was there at all, which is the difference between "sign in" and "sign in again".
 *  Touches the database only when there is a bearer to look up. */
export async function connectorIdentity(event: H3Event): Promise<{ identity: ConnectorIdentity | null; carried: boolean }> {
  const raw = connectorToken(event);
  if (!raw) return { identity: null, carried: false };
  return { identity: await resolveBearer(await useAccountDb(), raw), carried: true };
}

// ---- answering the HTTP side ---------------------------------------------------------------

/** The refusal that starts a sign-in (401) or a step-up (403): the header is the
 *  signal, the JSON body only says it in words. RFC 6750 §3. */
export function bearerChallenge(
  event: H3Event,
  challenge: { status: 401 | 403; error: "invalid_token" | "insufficient_scope"; scope: AccessScope; description: string },
): { error: string; error_description: string } {
  const quoted = (s: string) => `"${s.replace(/["\\]/g, "")}"`;
  setResponseStatus(event, challenge.status);
  setHeader(
    event,
    "WWW-Authenticate",
    `Bearer error=${quoted(challenge.error)}, error_description=${quoted(challenge.description)}, resource_metadata=${quoted(`${trustedOrigin(event)}/.well-known/oauth-protected-resource/mcp`)}, scope=${quoted(challenge.scope)}`,
  );
  return { error: challenge.error, error_description: challenge.description };
}

/** An RFC 6749 §5.2 error: the status, the no-store, and the two-field body. */
export function oauthError(event: H3Event, status: number, error: string, description: string) {
  setResponseStatus(event, status);
  setNoStore(event);
  return { error, error_description: description };
}

/** A form-encoded body (what the token and revocation endpoints take), or JSON when
 *  a client sends that instead, as a flat string map. Capped on the bytes received. */
export async function readFormBody(event: H3Event, maxBytes = 8_192): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if ((getHeader(event, "content-type") ?? "").toLowerCase().includes("application/json")) {
    const parsed = await readJsonBodyCapped<Record<string, unknown>>(event, maxBytes);
    for (const [k, v] of Object.entries(parsed ?? {})) if (typeof v === "string") out[k] = v;
    return out;
  }
  const raw = await readRawBody(event, false).catch(() => undefined);
  if (!raw || raw.length === 0 || raw.length > maxBytes) return out;
  for (const [k, v] of new URLSearchParams(raw.toString("utf8"))) out[k] = v;
  return out;
}
