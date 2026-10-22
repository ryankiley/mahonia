// Personal access tokens: the way an assistant reaches its owner's My Gear over MCP.
//
// The session cookie is the capability everywhere else (vaultAuth.ts), and that is
// right for a browser. An MCP client is not one: it is a process on someone's machine
// that sends a header it was configured with. So a signed-in person mints a token on
// /account, pastes it into their client once, and the client sends it as
// `Authorization: Bearer …` on every call to /mcp.
//
// Same storage rule as a session and a magic link: the raw value exists only in the
// response that mints it, and the table holds its sha256, so a dump of
// `access_tokens` is not a set of credentials. What a token can do is narrower than a
// session — it reaches the account's gear and nothing else (no lists by claim, no
// passkeys, no export, no deletion) — and `scope` narrows it once more to reading.
//
// No expiry. A token sits in a config file the person chose to put it in, and one
// that quietly died after 90 days would break their assistant in a way that reads as
// a server fault. Revoking is the way out, and "sign out everywhere" revokes them all,
// because a token minted by whoever got into the account is exactly what that action
// exists to remove.

import { and, desc, eq } from "drizzle-orm";
import type { H3Event } from "h3";
import { accessTokens } from "../db/schema";
import type { Db } from "./db";
import { bearerToken } from "./http";
import { randomSecret, sha256Hex } from "./tokens";

export type AccessScope = "read" | "write";
export const ACCESS_SCOPES: readonly AccessScope[] = ["read", "write"];

/** Recognisable in a config file or a leaked paste, and lets the MCP route tell a
 *  token from some other bearer value without a database round trip. */
export const ACCESS_TOKEN_PREFIX = "pack_";

/** Enough for every client a person uses, few enough that the list stays reviewable. */
export const ACCESS_TOKENS_MAX = 10;

const LABEL_MAX = 60;

/** Only rewrite last_used_at when it is more than an hour stale — the column answers
 *  "is this one still in use?", which needs no finer grain than that, and an
 *  assistant can make dozens of calls a minute. */
const TOUCH_AFTER_MS = 60 * 60_000;

export interface AccessTokenSummary {
  id: number;
  label: string | null;
  scope: AccessScope;
  createdAt: string;
  lastUsedAt: string | null;
}

export function isAccessScope(v: unknown): v is AccessScope {
  return v === "read" || v === "write";
}

/**
 * Mint a token and return the RAW value — the only moment it exists in plaintext.
 * Null when the account already holds the maximum, so the caller can say so.
 */
export async function createAccessToken(
  db: Db,
  userId: number,
  opts: { label?: string | null; scope: AccessScope },
): Promise<{ id: number; token: string } | null> {
  const have = await db.select({ id: accessTokens.id }).from(accessTokens).where(eq(accessTokens.userId, userId));
  if (have.length >= ACCESS_TOKENS_MAX) return null;
  const token = ACCESS_TOKEN_PREFIX + randomSecret();
  const label = (opts.label ?? "").trim().slice(0, LABEL_MAX) || null;
  const [row] = await db
    .insert(accessTokens)
    .values({ tokenHash: sha256Hex(token), userId, label, scope: opts.scope })
    .returning();
  return { id: row!.id, token };
}

/** The account's tokens for /account — metadata only; the value is gone for good. */
export async function listAccessTokens(db: Db, userId: number): Promise<AccessTokenSummary[]> {
  const rows = await db
    .select()
    .from(accessTokens)
    .where(eq(accessTokens.userId, userId))
    .orderBy(desc(accessTokens.createdAt), desc(accessTokens.id));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    scope: isAccessScope(r.scope) ? r.scope : "read",
    createdAt: new Date(r.createdAt).toISOString(),
    lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : null,
  }));
}

/** Revoke one. Scoped by userId as well as id, so another account's id matches
 *  nothing — the same answer as an id that never existed. */
export async function revokeAccessToken(db: Db, userId: number, id: number): Promise<boolean> {
  const gone = await db
    .delete(accessTokens)
    .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, userId)))
    .returning();
  return gone.length > 0;
}

/** Revoke every token the account holds — sign out everywhere, and account deletion. */
export async function revokeAllAccessTokens(db: Db, userId: number): Promise<number> {
  const gone = await db.delete(accessTokens).where(eq(accessTokens.userId, userId)).returning();
  return gone.length;
}

/** The connector's access token, or null. Only a bearer carrying our prefix counts,
 *  so a client that forwards some other credential is simply anonymous here rather
 *  than looked up. */
export function accessTokenFrom(event: H3Event): string | null {
  const token = bearerToken(event);
  return token.startsWith(ACCESS_TOKEN_PREFIX) && token.length <= 200 ? token : null;
}

/**
 * Who a raw token belongs to and what it may do, or null for a token that was never
 * issued or has been revoked. Bumps last_used_at, best-effort: a failed bump must
 * not fail the call that carried it.
 */
export async function resolveAccessToken(
  db: Db,
  raw: string,
): Promise<{ userId: number; scope: AccessScope } | null> {
  const [row] = await db
    .select()
    .from(accessTokens)
    .where(eq(accessTokens.tokenHash, sha256Hex(raw)))
    .limit(1);
  if (!row || !isAccessScope(row.scope)) return null;
  const now = Date.now();
  if (!row.lastUsedAt || now - new Date(row.lastUsedAt).getTime() > TOUCH_AFTER_MS) {
    await db
      .update(accessTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(accessTokens.id, row.id))
      .catch(() => {});
  }
  return { userId: row.userId, scope: row.scope };
}
