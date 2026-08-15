// Accounts for the vault: magic-link issuance, single-use redemption, and the
// session cookie. Deliberately small — there are no passwords, no profile fields,
// and no roles, so this file is the whole of "who is signed in".
//
// THREE SECRETS, ONE RULE: the magic-link token and the session cookie are
// high-entropy random values stored ONLY as sha256, exactly like a list's edit
// token (server/utils/tokens.ts). A dump of `auth_tokens` or `sessions` therefore
// contains no usable credential.

import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { H3Event } from "h3";
import { createError, deleteCookie, getCookie, setCookie } from "h3";
import { authTokens, credentials, sessions, users } from "../db/schema";
import { useAccountDb } from "./db";
import { randomSecret, sha256Hex } from "./tokens";

type Db = Awaited<ReturnType<typeof useAccountDb>>;

/** The session cookie's name. `mh_` prefixed so it's obviously ours in devtools. */
export const SESSION_COOKIE = "mh_session";

/**
 * A readable companion flag set alongside the session — NOT a credential.
 *
 * The session cookie is HttpOnly, so script can't tell whether one exists, and
 * the only way to find out would be to ask /api/auth/me on every page load. That
 * is a bad trade on this site specifically: `/e` is prerendered and CDN-served
 * with zero function invocations, and the overwhelming majority of visitors have
 * no account at all — adding a server round-trip to their first paint to discover
 * "no, still signed out" is a real cost for no benefit.
 *
 * So sign-in also drops this flag, which carries no capability whatsoever: it says
 * only "there is probably a session, worth asking". Forging it buys an attacker
 * one 401. Signed-out visitors read a cookie that isn't there and make no request.
 */
export const SESSION_HINT_COOKIE = "mh_signed_in";

/** How long a magic link stays redeemable. Short — it's a live credential sitting
 *  in an inbox, and the whole flow (request → click) takes seconds. */
export const MAGIC_LINK_TTL_MS = 15 * 60_000;

/** How long a signed-in browser stays signed in, refreshed on use (see
 *  `resolveSession`). Long, because the alternative — re-emailing yourself every
 *  fortnight to see your own gear list — is precisely the friction this app avoids
 *  everywhere else. */
const SESSION_TTL_MS = 90 * 24 * 60 * 60_000;

/** Only rewrite the expiry when a session is more than a day into its window.
 *  Sliding expiry with no floor would mean a DB write on every single request. */
const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60_000;

export interface SessionUser {
  id: number;
  email: string;
}

/** A user just returned by redeeming a magic link, which is the one moment the
 *  address-verification state matters — see `claimUnverifiedAccount`. Everything
 *  else in the app only ever needs `SessionUser`. */
export interface RedeemedUser extends SessionUser {
  /** Whether anyone had proved they hold this address BEFORE this redemption. */
  emailVerified: boolean;
}

/**
 * Normalize an email to its storage form: trimmed and lowercased. This IS the
 * identity — `Alex@Example.com` and `alex@example.com` are one account — so it
 * runs on every read and write path, never just at signup.
 *
 * Validation is deliberately loose (one @, something either side, no whitespace):
 * the real proof that an address is valid and reachable is that a link sent to it
 * comes back, and that check happens for free in this design. A stricter regex
 * would only reject deliverable addresses.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

/** Find the account for `email`, creating it on first sign-in. There is no
 *  separate signup: requesting a link for an unknown address IS the signup, which
 *  is what keeps the flow to one field and one click. */
export async function findOrCreateUser(db: Db, email: string): Promise<SessionUser> {
  const existing = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing[0]) return existing[0];
  // ON CONFLICT DO NOTHING + re-read: two link requests racing for the same new
  // address would otherwise fail one of them on the unique index.
  //
  // emailVerified: true — this row can only ever be reached through the inbox.
  // Requesting a link isn't itself proof of holding one, but the row this creates
  // carries no passkey and no session, and `createAccount` never upserts, so a
  // later passkey signup for the same address is refused by the unique index. The
  // flag's only job is gating the eviction below, and there is nothing here to
  // evict. See accountSchema.ts.
  // no-arg .returning() — the neon-http | PGlite union's only shared overload
  const inserted = await db
    .insert(users)
    .values({ email, emailVerified: true })
    .onConflictDoNothing({ target: users.email })
    .returning();
  const fresh = inserted[0];
  if (fresh) return { id: fresh.id, email: fresh.email };
  const raced = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!raced[0]) throw new Error("could not create user");
  return raced[0];
}

/**
 * Create a NEW account for `email` — the passkey signup path.
 *
 * Unlike findOrCreateUser this never returns an existing row: a passkey signup is
 * always a new account, so an address that already has one is a conflict rather
 * than a sign-in. That's deliberate — silently signing someone into an existing
 * account because the address matched would let anyone with a known address
 * attach their own passkey to it.
 *
 * Throws on the unique index if the address was taken between the check in
 * signup-options and here. Called only AFTER the ceremony verifies, so a row is
 * never created on the strength of an unverified request.
 *
 * THE ADDRESS IS UNVERIFIED, and the row says so. Nothing on this path proves the
 * person enrolling the passkey can read the inbox they typed — that's the whole
 * point of the route, which trades the inbox round trip for a signup with no
 * waiting. `emailVerified: false` is what makes the trade safe: the first link
 * redeemed against this address evicts the passkey. Set explicitly rather than
 * left to the column default, because it's a security property and it should be
 * readable here.
 */
export async function createAccount(db: Db, email: string): Promise<SessionUser> {
  const inserted = await db.insert(users).values({ email, emailVerified: false }).returning();
  const row = inserted[0];
  if (!row) throw new Error("could not create account");
  return { id: row.id, email: row.email };
}

/** Remove an account ROW and nothing else. Used for exactly one thing: rolling
 *  back a passkey signup whose credential failed to save, where the alternative is
 *  an account nothing can ever sign into.
 *
 *  Deliberately NOT called deleteAccount — accountRepo exports that, and every file
 *  in server/utils is auto-imported into one namespace, so two exports sharing a
 *  name means one silently wins and callers get whichever the resolver picked. */
export async function deleteAccountRow(db: Db, userId: number): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

/** Is this address already on some OTHER account? Attaching must not silently
 *  merge two accounts, and must not let one person's address be claimed onto
 *  someone else's account. */
export async function emailTaken(db: Db, email: string, exceptUserId: number): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return Boolean(rows[0]) && rows[0]!.id !== exceptUserId;
}

/**
 * Mint a magic-link token for `userId` and return the RAW value (the only moment
 * it exists in plaintext — the caller emails it and drops it).
 *
 * Any of the user's still-pending links are consumed first, so requesting a new
 * link invalidates the previous one: an inbox never accumulates several
 * simultaneously-valid keys to the same account.
 */
export async function issueMagicToken(db: Db, userId: number): Promise<string> {
  await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(authTokens.userId, userId), isNull(authTokens.consumedAt)));
  const token = randomSecret();
  await db.insert(authTokens).values({
    tokenHash: sha256Hex(token),
    userId,
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
  });
  return token;
}

/**
 * Redeem a magic-link token, returning the user it belonged to (or null for
 * anything expired, already-used, or unknown — one indistinguishable answer, so
 * the endpoint can't be used to probe which tokens ever existed).
 *
 * The stamp and the check are ONE statement: `WHERE consumed_at IS NULL` inside
 * the UPDATE means two requests racing on the same link (the classic double-click,
 * or a mail client prefetching while the human clicks) can only both match if the
 * database lets them, which it does not — the loser updates zero rows and gets
 * null. A read-then-write would have a window where both pass.
 */
export async function consumeMagicToken(db: Db, rawToken: string): Promise<RedeemedUser | null> {
  if (!rawToken) return null;
  const now = new Date();
  const claimed = await db
    .update(authTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authTokens.tokenHash, sha256Hex(rawToken)),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    // no-arg .returning() — the neon-http | PGlite union's only shared overload
    .returning();
  const userId = claimed[0]?.userId;
  if (userId == null) return null;
  const row = await db
    .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row[0] ?? null;
}

/**
 * Hand an unverified account to the person who just proved they hold its address,
 * and evict everyone who was there first.
 *
 * THE HOLE THIS CLOSES. Passkey signup takes an address from an unauthenticated
 * body and attaches a credential to it, so anyone can sign up as
 * someone@else.com and leave a discoverable passkey on that account. Because
 * `findOrCreateUser` resolves by address, the real owner's later sign-in lands
 * them in that same row — inside an account a stranger can re-open at will, with
 * their vault, their claimed lists and their address in it. Account
 * pre-hijacking, the unverified-email variant.
 *
 * WHY EVICTING EVERYTHING IS THE RIGHT PRICE. Whoever redeems a link sent to an
 * address IS that address's owner; that is the only thing an emailed link can
 * prove, and it's exactly the thing in question here. So every passkey and every
 * session predating this moment was created by someone who had not proved it, and
 * goes. An attacker who never held the inbox can never reach this code at all.
 *
 * WHAT IT COSTS THE INNOCENT CASE, honestly: someone who signed up with a passkey
 * and does hold the address loses that passkey if they redeem a link — the code
 * cannot tell the two people apart, which is the whole problem. That is why the
 * welcome mail names the consequence and doesn't ask them to click (email.ts);
 * the link in it is there for the other reader. The account is never at stake
 * either way — whoever holds the address is signed in at the end of this, and a
 * passkey takes one tap to add again.
 *
 * ORDER: evict first, flip last. A failure part-way then leaves the account still
 * unverified, so the next link redoes the eviction — whereas flipping first and
 * failing would leave a verified account still carrying a stranger's passkey, with
 * nothing left to try again.
 */
export async function claimUnverifiedAccount(db: Db, userId: number): Promise<void> {
  await db.delete(credentials).where(eq(credentials.userId, userId));
  // Sessions too, not just the passkeys: removing a credential stops it signing
  // in AGAIN, but a session it already started keeps working for 90 days. Same
  // reasoning as endAllSessions.
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, userId));
}

/** Whether to set the `Secure` cookie attribute. Off on plain-HTTP localhost
 *  (where a Secure cookie is simply dropped and dev sign-in would silently never
 *  work), on everywhere else. */
function isSecureRequest(event: H3Event): boolean {
  if (process.env.NODE_ENV === "production") return true;
  const proto = event.node.req.headers["x-forwarded-proto"];
  return (Array.isArray(proto) ? proto[0] : proto) === "https";
}

/**
 * Start a signed-in session: mint the cookie value, store its hash, set the
 * cookie.
 *
 * HttpOnly — no script ever needs to read it, and the app's CSP already allows
 * inline script, so keeping it off `document.cookie` matters.
 * SameSite=Lax — the sign-in link is a cross-site top-level GET from an email
 * client, which Lax permits, while still blocking the cross-site POSTs that CSRF
 * needs. Every mutating vault endpoint is a POST, so Lax alone carries the CSRF
 * defence here.
 */
/** Write both cookies with one expiry. Split out because sign-in and the sliding
 *  refresh both set them, and a difference between the two would be invisible
 *  until someone was logged out early. */
function setSessionCookies(event: H3Event, token: string, expiresAt: Date): void {
  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(event),
    path: "/",
    expires: expiresAt,
  });
  // deliberately readable (httpOnly: false) — see SESSION_HINT_COOKIE
  setCookie(event, SESSION_HINT_COOKIE, "1", {
    httpOnly: false,
    sameSite: "lax",
    secure: isSecureRequest(event),
    path: "/",
    expires: expiresAt,
  });
}

export async function startSession(event: H3Event, db: Db, userId: number): Promise<void> {
  const token = randomSecret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: sha256Hex(token), userId, expiresAt });
  setSessionCookies(event, token, expiresAt);
}

/**
 * Resolve the signed-in user from the request's cookie, or null.
 *
 * Refreshes a session that's more than SESSION_REFRESH_AFTER_MS old (sliding
 * expiry: someone who uses the app keeps their session; someone who doesn't is
 * logged out after 90 quiet days). The refresh is best-effort — a failed bump
 * must not fail the request that carried it.
 */
export async function resolveSession(event: H3Event): Promise<SessionUser | null> {
  const raw = getCookie(event, SESSION_COOKIE);
  if (!raw) return null;
  const db = await useAccountDb();
  const now = new Date();
  const rows = await db
    .select({
      sessionId: sessions.id,
      lastUsedAt: sessions.lastUsedAt,
      id: users.id,
      email: users.email,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(raw)), gt(sessions.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (now.getTime() - new Date(row.lastUsedAt).getTime() > SESSION_REFRESH_AFTER_MS) {
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await db
      .update(sessions)
      .set({ lastUsedAt: now, expiresAt })
      .where(eq(sessions.id, row.sessionId))
      .catch(() => {});
    await db
      .update(users)
      .set({ lastSeenAt: now })
      .where(eq(users.id, row.id))
      .catch(() => {});
    // AND RE-SET THE COOKIES. Sliding the row alone slides nothing the user can
    // feel: the browser still drops the cookie 90 days after SIGN-IN, so someone
    // who uses Mahonia every week is signed out on day 90 while holding a session
    // the server considers perfectly valid — and the hint cookie expires with it,
    // so the app doesn't even ask.
    setSessionCookies(event, raw, expiresAt);
  }
  return { id: row.id, email: row.email };
}

/** Resolve the signed-in user or reject with 401. Every vault endpoint's first
 *  line — the vault is per-person by definition, so there is no anonymous mode to
 *  fall back to. */
export async function requireUser(event: H3Event): Promise<SessionUser> {
  const user = await resolveSession(event);
  if (!user) throw createError({ statusCode: 401, statusMessage: "Sign in required" });
  return user;
}

/** Sign out: drop the session row (so the cookie is dead even if it's already been
 *  copied elsewhere) and clear the cookie. */
export async function endSession(event: H3Event): Promise<void> {
  const raw = getCookie(event, SESSION_COOKIE);
  deleteCookie(event, SESSION_COOKIE, { path: "/" });
  deleteCookie(event, SESSION_HINT_COOKIE, { path: "/" });
  if (!raw) return;
  const db = await useAccountDb();
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(raw)));
}

/**
 * End EVERY session this account has, on every device, including this one.
 *
 * The missing half of "remove this passkey". Removing a credential stops it being
 * used to sign in AGAIN, but any session it already started keeps working for its
 * full 90 days — so the action a person reaches for when they think someone else
 * got in doesn't actually put them out. This does.
 *
 * Deliberately takes the caller's own session too, rather than sparing it. Sparing
 * it means deciding the current device is the trustworthy one, which is exactly
 * the assumption someone in this situation can't safely make. Signing back in is
 * one tap with a passkey.
 */
export async function endAllSessions(event: H3Event, userId: number): Promise<number> {
  const db = await useAccountDb();
  const gone = await db.delete(sessions).where(eq(sessions.userId, userId)).returning();
  deleteCookie(event, SESSION_COOKIE, { path: "/" });
  deleteCookie(event, SESSION_HINT_COOKIE, { path: "/" });
  return gone.length;
}

/**
 * Drop expired sessions and spent magic links. Cheap, index-backed, and safe to
 * run repeatedly — called opportunistically from the link-request path (a rare,
 * heavily rate-limited endpoint) so the two tables can't grow without bound
 * without needing a cron of their own.
 */
export async function sweepExpiredAuth(db: Db): Promise<void> {
  const now = new Date();
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  await db
    .delete(authTokens)
    .where(
      or(
        lt(authTokens.expiresAt, now),
        // a consumed link is spent the moment it's redeemed, but keep it briefly so
        // a user double-clicking their link gets "already used" rather than a bare
        // "unknown link" while the first click's session is still being set up
        and(
          sql`${authTokens.consumedAt} is not null`,
          lt(authTokens.consumedAt, new Date(now.getTime() - MAGIC_LINK_TTL_MS)),
        ),
      ),
    );
}
