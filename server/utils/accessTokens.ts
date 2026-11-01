// The connector's credentials: the bearer an MCP client sends to reach one account's
// My Gear, in its two kinds.
//
// Everything else on an account opens with the session cookie, and a browser carries
// that on its own. The connector is a different animal: a process on someone's
// machine with no cookie jar, so it has to be given something to send in a header.
// A client configured from a file (Claude Code without the popup, Cursor, anything
// with an mcp.json) is given a TOKEN minted on the account page, pasted in once. An
// app that can open a sign-in (Claude's apps, from a Connect card) is given a pair by
// the token endpoint after the person allows it (server/utils/oauth.ts): an access
// token that lasts an hour and a refresh token that renews the pair. Both are rows
// here, told apart by `kind`, and resolve the same way: hash the bearer, find the
// row, read the account and the scope.
//
// Kept the way a session or a magic link is kept: hashed. The table holds sha256 of
// each value and nothing replayable; a value itself exists in one HTTP response, the
// one that issued it. A credential here is also narrower than a session. It reaches
// the account's gear, and lets a list the connector makes be filed under the
// account, and that is all — no passkeys, no takeout, no delete, and none of the
// lists the account has already claimed. A read-only one gives up the writes as well.
//
// A hand-minted token doesn't expire: the person put it in a config file expecting
// the assistant to keep working, and a token that lapsed on its own would come back
// months later as a failure nobody can explain. An app's access token does expire,
// because its client knows how to refresh; its refresh token lasts until revoked.
// Ending either is deliberate — revoke it on the account page — and "Sign out
// everywhere" revokes all of them, because a credential minted or granted by whoever
// got into the account is exactly what ending every session wouldn't reach.

import { and, desc, eq, or, sql } from "drizzle-orm";
import type { H3Event } from "h3";
import type { AccessScope, AccessTokenSummary } from "../../shared/types";
import { accessTokens } from "../db/schema";
import type { Db } from "./db";
import { bearerToken } from "./http";
import { toIso } from "./time";
import { randomSecret, sha256Hex } from "./tokens";

/**
 * Every raw value starts with this. Two jobs: the MCP route can tell one of ours from
 * any other bearer a client might forward without touching the database, and a value
 * that leaks into a paste or a repo is recognisable for what it is, which is what
 * secret scanners key on. The product's name rather than the cookies' `mh_`: a
 * cookie is only ever seen in devtools, a token is seen in config files. The two
 * app-issued kinds carry a second word so a leaked one says which it is; nothing
 * routes on it.
 */
export const ACCESS_TOKEN_PREFIX = "mahonia_";
export const APP_ACCESS_PREFIX = "mahonia_at_";
export const APP_REFRESH_PREFIX = "mahonia_rt_";

/** Hand-minted tokens one account may hold at once. One per client is the expected
 *  use; the ceiling keeps the list on the account page short enough to review. */
export const ACCESS_TOKENS_MAX = 10;

/** An app's access token's life. Short, because its client refreshes for free and a
 *  leaked one should not be worth much for long. */
export const APP_ACCESS_TTL_S = 60 * 60;

/** The longest raw value the route will even hash: a prefix plus a base64url secret
 *  is about fifty characters, so anything much longer is not one of ours. */
const RAW_TOKEN_MAX = 200;

const LABEL_MAX = 60;

/** `last_used_at` answers "is anything still using this?" on the account page. An
 *  hour's grain answers that, and an assistant can make a call a second. */
const LAST_USED_GRAIN_MS = 60 * 60_000;

export function isAccessScope(value: unknown): value is AccessScope {
  return value === "read" || value === "write";
}

/** The account behind a bearer and the most it may do. */
export interface ConnectorIdentity {
  userId: number;
  scope: AccessScope;
}

/** The token endpoint's answer (RFC 6749 §5.1): the pair, and what it may do. */
export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: AccessScope;
}

/**
 * Mint a token by hand for `userId`. The returned `token` is the raw value, and this
 * is the only place it ever exists in the clear. Null when the account is at the
 * ceiling, so the route can say so instead of silently minting an eleventh. Apps
 * don't count against it: they are listed, but it is the hand-minted list that has
 * to stay short enough to read.
 */
export async function mintAccessToken(
  db: Db,
  userId: number,
  opts: { label?: string | null; scope: AccessScope },
): Promise<{ id: number; token: string } | null> {
  const [{ held } = { held: 0 }] = await db
    .select({ held: sql<number>`count(*)` })
    .from(accessTokens)
    .where(and(eq(accessTokens.userId, userId), eq(accessTokens.kind, "token")));
  if (Number(held) >= ACCESS_TOKENS_MAX) return null;
  const token = ACCESS_TOKEN_PREFIX + randomSecret();
  const label = (opts.label ?? "").trim().slice(0, LABEL_MAX) || null;
  const [row] = await db
    .insert(accessTokens)
    .values({ tokenHash: sha256Hex(token), userId, kind: "token", label, scope: opts.scope })
    .returning();
  return { id: row!.id, token };
}

/** a fresh access + refresh pair: the raw values, their hashes, and the access expiry */
function freshPair(scope: AccessScope) {
  const access = APP_ACCESS_PREFIX + randomSecret();
  const refresh = APP_REFRESH_PREFIX + randomSecret();
  return {
    set: { tokenHash: sha256Hex(access), refreshHash: sha256Hex(refresh), expiresAt: new Date(Date.now() + APP_ACCESS_TTL_S * 1000) },
    issued: { access_token: access, token_type: "Bearer" as const, expires_in: APP_ACCESS_TTL_S, refresh_token: refresh, scope },
  };
}

/** A new grant for an app that was just allowed: the row, and its first pair. */
export async function issueAppTokens(
  db: Db,
  grant: { userId: number; clientId: string; label: string; scope: AccessScope },
): Promise<IssuedTokens> {
  const pair = freshPair(grant.scope);
  await db.insert(accessTokens).values({ ...pair.set, userId: grant.userId, kind: "app", clientId: grant.clientId, label: grant.label, scope: grant.scope });
  return pair.issued;
}

/**
 * Trade a refresh token for the next pair, rotating both hashes in one UPDATE keyed
 * on the old refresh hash. Only the client the grant was made for may refresh it, so
 * the client_id travels with the request and is matched here. A refresh token that
 * was never issued matches nothing, which the token endpoint reports as
 * invalid_grant — the one error Claude reads as "sign in again" rather than "retry".
 *
 * A refresh token that WAS issued and has since been rotated away is the one sign
 * this server can see of a stolen one (OAuth 2.1 §4.3.1): two parties held it, and
 * whichever presented it second is not the client. The grant ends on the spot, and
 * the client that still has a working pair finds it dead and signs the person in
 * again — the cost of a lost response on a flaky network, paid once.
 */
export async function refreshAppTokens(db: Db, rawRefresh: unknown, clientId: unknown): Promise<IssuedTokens | null> {
  if (typeof rawRefresh !== "string" || !rawRefresh.startsWith(APP_REFRESH_PREFIX) || rawRefresh.length > RAW_TOKEN_MAX) return null;
  if (typeof clientId !== "string" || !clientId) return null;
  const hash = sha256Hex(rawRefresh);
  const [row] = await db
    .select({ id: accessTokens.id, scope: accessTokens.scope, refreshHash: accessTokens.refreshHash })
    .from(accessTokens)
    .where(and(or(eq(accessTokens.refreshHash, hash), eq(accessTokens.refreshPrevHash, hash)), eq(accessTokens.clientId, clientId)))
    .limit(1);
  if (!row || !isAccessScope(row.scope)) return null;
  if (row.refreshHash !== hash) {
    await db.delete(accessTokens).where(eq(accessTokens.id, row.id));
    return null;
  }
  const pair = freshPair(row.scope);
  const [rotated] = await db
    .update(accessTokens)
    .set({ ...pair.set, refreshPrevHash: hash, lastUsedAt: new Date() })
    // keyed on the OLD refresh hash again, so two refreshes racing with one token
    // can't both succeed: the second matches nothing
    .where(and(eq(accessTokens.refreshHash, hash), eq(accessTokens.clientId, clientId)))
    .returning();
  return rotated ? pair.issued : null;
}

/** RFC 7009: a token presented for revocation ends the whole grant, whichever of the
 *  pair it was. A hand-minted token revokes itself the same way. Idempotent: a value
 *  that matches nothing was revoked already, as far as the caller can tell. */
export async function revokeByToken(db: Db, raw: unknown): Promise<boolean> {
  if (typeof raw !== "string" || !raw.startsWith(ACCESS_TOKEN_PREFIX) || raw.length > RAW_TOKEN_MAX) return false;
  const hash = sha256Hex(raw);
  const column = raw.startsWith(APP_REFRESH_PREFIX) ? accessTokens.refreshHash : accessTokens.tokenHash;
  const gone = await db.delete(accessTokens).where(eq(column, hash)).returning();
  return gone.length > 0;
}

/** The account's credentials as the account page shows them: newest first, metadata
 *  only. There is no column that could give a value back. */
export async function listAccessTokens(db: Db, userId: number): Promise<AccessTokenSummary[]> {
  const rows = await db
    .select({ id: accessTokens.id, kind: accessTokens.kind, label: accessTokens.label, scope: accessTokens.scope, createdAt: accessTokens.createdAt, lastUsedAt: accessTokens.lastUsedAt })
    .from(accessTokens)
    .where(eq(accessTokens.userId, userId))
    .orderBy(desc(accessTokens.createdAt), desc(accessTokens.id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === "app" ? "app" : "token",
    label: r.label,
    // the CHECK constraint already holds the column to the two words; the fallback
    // is the safe reading of a row that somehow got past it
    scope: isAccessScope(r.scope) ? r.scope : "read",
    createdAt: toIso(r.createdAt),
    lastUsedAt: r.lastUsedAt ? toIso(r.lastUsedAt) : null,
  }));
}

/** Revoke one credential from the account page. The user id is part of the WHERE,
 *  so an id belonging to some other account deletes nothing and reads as "no such
 *  token", the same as a made-up id — no existence oracle across accounts. */
export async function revokeAccessToken(db: Db, userId: number, id: number): Promise<boolean> {
  const gone = await db
    .delete(accessTokens)
    .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, userId)))
    .returning();
  return gone.length > 0;
}

/** Every credential the account holds: "Sign out everywhere", and closing the account. */
export async function revokeAllAccessTokens(db: Db, userId: number): Promise<number> {
  const gone = await db.delete(accessTokens).where(eq(accessTokens.userId, userId)).returning();
  return gone.length;
}

/**
 * The raw bearer this request carries, or null. Only one with our prefix counts. A
 * client may forward some other credential on every request (an edit token, an API
 * key for a different service); that one is not looked up, and the request is
 * treated as carrying no bearer at all.
 */
export function connectorToken(event: H3Event): string | null {
  const raw = bearerToken(event);
  return raw.startsWith(ACCESS_TOKEN_PREFIX) && raw.length <= RAW_TOKEN_MAX ? raw : null;
}

/**
 * The account and scope behind a raw bearer, of either kind, or null for one that
 * opens nothing: never issued, revoked, or an app's access token past its hour,
 * which its client is expected to refresh. Stamps `last_used_at` as a side effect,
 * no more than once an hour, and swallows a failed stamp: the call that carried the
 * bearer must not fail over bookkeeping.
 */
export async function resolveBearer(db: Db, raw: string): Promise<ConnectorIdentity | null> {
  const [row] = await db
    .select({ id: accessTokens.id, userId: accessTokens.userId, scope: accessTokens.scope, expiresAt: accessTokens.expiresAt, lastUsedAt: accessTokens.lastUsedAt })
    .from(accessTokens)
    .where(eq(accessTokens.tokenHash, sha256Hex(raw)))
    .limit(1);
  if (!row || !isAccessScope(row.scope)) return null;
  const now = Date.now();
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) return null;
  if (!row.lastUsedAt || now - new Date(row.lastUsedAt).getTime() > LAST_USED_GRAIN_MS) {
    await db
      .update(accessTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(accessTokens.id, row.id))
      .catch(() => {});
  }
  return { userId: row.userId, scope: row.scope };
}
