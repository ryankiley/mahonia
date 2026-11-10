// Accounts for the vault: magic-link issuance, single-use redemption, and the
// session cookie. Deliberately small — there are no passwords, no profile fields,
// and no roles, so this file is the whole of "who is signed in".
//
// THREE SECRETS, ONE RULE: the magic-link token and the session cookie are
// high-entropy random values stored ONLY as sha256, exactly like a list's edit
// token (server/utils/tokens.ts). A dump of `auth_tokens` or `sessions` therefore
// contains no usable credential.

import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { H3Event } from "h3";
import { createError, deleteCookie, getCookie, setCookie } from "h3";
import { authTokens, credentials, oauthCodes, sessions, users } from "../db/schema";
import { revokeAllAccessTokens } from "./accessTokens";
import { useAccountDb, type Db } from "./db";
import { setNoIndex, setPrivate } from "./http";
import { rateLimit, type RateLimitAction } from "./rateLimit";
import { randomSecret, sha256Hex } from "./tokens";
import { SESSION_HINT_COOKIE, SESSION_OWNER_COOKIE } from "../../shared/session";
import { sendMagicLink, type MagicLinkEmail } from "./email";
import { trustedOrigin } from "./origin";

/** The session cookie's name. `mh_` prefixed so it's obviously ours in devtools. */
export const SESSION_COOKIE = "mh_session";

/*
 * SESSION_HINT_COOKIE (shared/session): a readable companion flag set alongside the
 * session — NOT a credential.
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

interface SessionUser {
  id: number;
  email: string;
}

/** The signed-in user as a request sees them. The display name rides along
 *  because resolveSession already joins `users` for the email — so /api/auth/me
 *  (and anything rendering a byline) reads one source with no second query. */
interface ResolvedUser extends SessionUser {
  displayName: string | null;
  /** The session's readable owner marker (sessionOwnerMarker) — what the browser
   *  keys this account's local caches by, handed to /api/auth/me so the client can
   *  tell one account's answer from the next's without ever seeing an id. */
  owner: string;
  /** Whether this session's browser may attach the lists it made to the account
   *  without asking. See startSession. */
  sweep: boolean;
  /** Which ACCOUNT this is, as an opaque marker that is the same across its
   *  sessions (accountMarker), where `owner` is new with each one. */
  account: string;
}

/** A user just returned by redeeming a magic link, which is the one moment the
 *  address-verification state matters — see `claimUnverifiedAccount`. Everything
 *  else in the app only ever needs `SessionUser`. */
interface RedeemedUser extends SessionUser {
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
  // Nothing invisible: the address is shown back to whoever opens its sign-in link
  // ("Sign in as ...?"), and a zero-width or direction-override character would let
  // one address be dressed as another there. No deliverable address has one.
  if (/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/.test(email)) return null;
  return email;
}

/** Find the account for `email`, creating it on first sign-in. There is no
 *  separate signup: requesting a link for an unknown address IS the signup, which
 *  is what keeps the flow to one field and one click. */
export async function findOrCreateUser(db: Db, email: string): Promise<SessionUser> {
  const existing = await userByEmail(db, email);
  if (existing) return existing;
  // ON CONFLICT DO NOTHING + re-read: two link requests racing for the same new
  // address would otherwise fail one of them on the unique index.
  //
  // emailVerified: true — this row can only ever be reached through the inbox.
  // Requesting a link isn't itself proof of holding one, but the row this creates
  // carries no passkey and no session, and `createAccount` never upserts, so a
  // later passkey signup for the same address is refused by the unique index. The
  // flag's only job is gating the eviction below, and there is nothing here to
  // evict. See accountSchema.ts.
  const inserted = await db
    .insert(users)
    .values({ email, emailVerified: true })
    .onConflictDoNothing({ target: users.email })
    .returning();
  const fresh = inserted[0];
  if (fresh) return { id: fresh.id, email: fresh.email };
  const raced = await userByEmail(db, email);
  if (!raced) throw new Error("could not create user");
  return raced;
}

/** The account at `email`, or null — the lookup the sign-in door, its race re-read and
 *  the attach check all make. */
async function userByEmail(db: Db, email: string): Promise<SessionUser | null> {
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return rows[0] ?? null;
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

/** Is this address already on an account? A passkey signup is always a new account,
 *  so an address that has one is a conflict, never a sign-in (see createAccount). */
export async function emailTaken(db: Db, email: string): Promise<boolean> {
  return !!(await userByEmail(db, email));
}

/**
 * Mail `userId` a magic link at `to`. NOT the origin that served this request: `Host`
 * is a claim by the caller, and this link is a live credential leaving the building —
 * a forged host here mails the account's key to whoever asked. trustedOrigin pins
 * production and keeps the request-derived origin for dev and previews, so those
 * still mail themselves working links without configuration. The two doors that send
 * one (the link request; the passkey signup's address confirmation) each spelled this
 * sequence, TTL arithmetic and all.
 */
export async function mailMagicLink(
  event: H3Event,
  db: Db,
  userId: number,
  to: string,
  opts: { purpose?: MagicLinkEmail["purpose"]; browserHash?: string } = {},
): Promise<void> {
  const { purpose, browserHash } = opts;
  const token = await issueMagicToken(db, userId, browserHash);
  const url = new URL("/auth/callback", trustedOrigin(event));
  url.searchParams.set("t", token);
  await sendMagicLink({
    to,
    url: url.toString(),
    expiresIn: `${Math.round(MAGIC_LINK_TTL_MS / 60_000)} minutes`,
    purpose,
  });
}

/**
 * Mint a magic-link token for `userId` and return the RAW value (the only moment
 * it exists in plaintext — the caller emails it and drops it).
 *
 * Any of the user's still-pending links are consumed first, so requesting a new
 * link invalidates the previous one: an inbox never accumulates several
 * simultaneously-valid keys to the same account.
 */
export async function issueMagicToken(db: Db, userId: number, browserHash?: string): Promise<string> {
  await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(authTokens.userId, userId), isNull(authTokens.consumedAt)));
  const token = randomSecret();
  await db.insert(authTokens).values({
    tokenHash: sha256Hex(token),
    userId,
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
    browserHash: browserHash ?? null,
  });
  return token;
}

/**
 * The cookie that says "this browser asked for a sign-in link".
 *
 * WHY A LINK NEEDS TO KNOW WHO ASKED. A sign-in link is a credential for the
 * account that asked for it, and it works in whichever browser opens it. So a
 * stranger could ask for a link to THEIR account and send it to you: your browser
 * redeemed it without a word, you were signed in as them, and the lists this
 * browser made were attached to their account a moment later (the claim sweep).
 * Login CSRF, with the sweep as its payload.
 *
 * So the browser that asks keeps a random value in this cookie, the link's row
 * keeps its hash, and only that browser is signed in silently. Anywhere else
 * (another device, a mail app's own browser, a link somebody sent you) the person
 * is shown the account and asked first: see redeemMagicLink.
 *
 * HttpOnly and Lax like the session: the page that redeems is ours, so the request
 * that carries this is same-site. `__Host-` wherever the cookie can be Secure, so
 * nothing but this exact host can set it: a nonce someone else could plant is a
 * link that opens silently for them. (Plain-http localhost can't carry the prefix,
 * and has no sibling host to worry about.)
 */
const signInNonceCookie = (event: H3Event) => (isSecureRequest(event) ? "__Host-mh_signin" : "mh_signin");

/** Leave the asking browser its nonce and return the hash the link's row keeps.
 *  A second request replaces the cookie, as it replaces the link. */
export function markAskingBrowser(event: H3Event): string {
  const nonce = randomSecret();
  setCookie(event, signInNonceCookie(event), nonce, cookieOpts(event, new Date(Date.now() + MAGIC_LINK_TTL_MS), true));
  return sha256Hex(nonce);
}

/** The asking browser's nonce as this request carries it, hashed, or null. */
export function askingBrowserHash(event: H3Event): string | null {
  const nonce = getCookie(event, signInNonceCookie(event));
  return nonce ? sha256Hex(nonce) : null;
}

export function forgetAskingBrowser(event: H3Event): void {
  deleteCookie(event, signInNonceCookie(event), { path: "/", secure: isSecureRequest(event) });
}

type Redemption =
  | { kind: "invalid" }
  /** A good link in a browser that didn't ask for it: nothing is spent, and the
   *  page asks the person, naming the account, before sending it again. `asked`
   *  is whether any browser asked (the welcome mail's link was asked for by
   *  nobody); `evicts` is whether signing in will clear the account of whoever
   *  was there first (claimUnverifiedAccount). The page words itself by both. */
  | { kind: "confirm"; email: string; asked: boolean; evicts: boolean }
  /** `sameBrowser`: redeemed by the browser that asked, not on a person's yes. */
  | { kind: "ok"; user: RedeemedUser; sameBrowser: boolean };

/**
 * Redeem a sign-in link for the browser presenting it.
 *
 * The browser that asked (its nonce hashes to the row's) is signed in at once.
 * Any other gets `confirm` and the link is left unspent, so the page can show
 * whose account this is and send it back with `confirmed`. Naming the address
 * tells the link's holder nothing new: redeeming it returns the same address.
 *
 * It also means a mail scanner that runs the landing page's script no longer
 * spends the link: it never held the cookie, so it only ever reaches `confirm`.
 */
export async function redeemMagicLink(
  db: Db,
  rawToken: string,
  from: { browserHash: string | null; confirmed: boolean },
): Promise<Redemption> {
  if (!rawToken) return { kind: "invalid" };
  const pending = await db
    .select({ email: users.email, emailVerified: users.emailVerified, browserHash: authTokens.browserHash })
    .from(authTokens)
    .innerJoin(users, eq(users.id, authTokens.userId))
    .where(
      and(
        eq(authTokens.tokenHash, sha256Hex(rawToken)),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const row = pending[0];
  if (!row) return { kind: "invalid" };
  const sameBrowser = !!row.browserHash && row.browserHash === from.browserHash;
  if (!sameBrowser && !from.confirmed) {
    return { kind: "confirm", email: row.email, asked: !!row.browserHash, evicts: !row.emailVerified };
  }
  const user = await consumeMagicToken(db, rawToken);
  return user ? { kind: "ok", user, sameBrowser } : { kind: "invalid" };
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
  // And every token, for the same reason and more so: a session ends in 90 days, an
  // assistant token or an app's refresh token never does, and minting one needs only
  // the session the stranger's passkey signup started. Left here, it kept reading and
  // writing the real owner's gear and lists long after this ran.
  await revokeAllAccessTokens(db, userId);
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
 * needs. Every mutating endpoint is a POST, so Lax carries the CSRF defence for
 * anything done AS a session; server/middleware/sameOrigin.ts is the second line,
 * and the only one for the requests that start a session and so have no cookie.
 */
/**
 * The readable owner marker for a session: a hash of the token's hash, cut to 16 hex
 * characters. Not a credential and not the user's id — it names WHICH account's
 * browser-local caches to read (see SESSION_OWNER_COOKIE), nothing more. A fresh
 * sign-in mints a new one, which the client reads as a change of owner and starts
 * those caches over — the safe direction. Derived rather than stored, so it needs no
 * column and no secret; one-way, so neither the token nor the row it hashes to can be
 * read back out of a cookie; and never the id, which would put a sequential number
 * in front of every script on the page.
 */
export function sessionOwnerMarker(tokenHash: string): string {
  return sha256Hex(`owner:${tokenHash}`).slice(0, 16);
}

/**
 * The readable marker for an ACCOUNT: the same on every session it ever has, which
 * the owner marker deliberately is not. For the one thing a browser keeps that
 * must wait for its account to come back rather than start over: edits to a list
 * typed offline and not yet sent (useLocalListStore). Like the owner marker it
 * names and does not unlock, and it is a hash rather than the id for the same
 * reason. Handed over by /api/auth/me only, to the account it describes.
 */
export function accountMarker(user: SessionUser): string {
  return sha256Hex(`account:${user.id}:${user.email}`).slice(0, 16);
}

/** The session's three cookies share one recipe — lax, secure where the request is,
 *  site-wide, one expiry — and differ only in whether the browser may read them. */
const cookieOpts = (event: H3Event, expires: Date, httpOnly: boolean) => ({
  httpOnly,
  sameSite: "lax" as const,
  secure: isSecureRequest(event),
  path: "/",
  expires,
});

/** Write the session cookie and its two readable companions with one expiry. Split
 *  out because sign-in and the sliding refresh both set them, and a difference
 *  between the two would be invisible until someone was logged out early. */
function setSessionCookies(event: H3Event, token: string, expiresAt: Date): void {
  setCookie(event, SESSION_COOKIE, token, cookieOpts(event, expiresAt, true));
  // deliberately readable (httpOnly: false) — see SESSION_HINT_COOKIE
  setCookie(event, SESSION_HINT_COOKIE, "1", cookieOpts(event, expiresAt, false));
  // Like the hint, this carries no authority. It lets the browser choose the
  // correct offline cache before /api/auth/me answers; changing it can only make
  // the browser hide its own cached data, never access another account.
  setCookie(event, SESSION_OWNER_COOKIE, sessionOwnerMarker(sha256Hex(token)), cookieOpts(event, expiresAt, false));
}

/**
 * `sweep` — whether this browser's lists may follow it into the account unasked.
 *
 * Signing in attaches the lists a browser made to the account (the claim sweep,
 * useClaimedLists().claimDeviceLists). Those lists carry edit rights, so the sweep
 * is only right when the person at this browser chose this account: a passkey
 * ceremony here, or a link this browser asked for. A link somebody merely pressed
 * "Sign in" on is not that. The press can be talked or tricked out of them, so it
 * signs them in and no more, and the lists wait for a question of their own
 * (allowSessionSweep). On the session row, not in the browser's storage: storage
 * is cleared under a session that lives on, and the answer has to outlast it.
 */
export async function startSession(event: H3Event, db: Db, userId: number, opts: { sweep: boolean }): Promise<void> {
  const token = randomSecret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ tokenHash: sha256Hex(token), userId, expiresAt, sweepOk: opts.sweep });
  setSessionCookies(event, token, expiresAt);
}

/** The person said yes to their lists following them into this session's account. */
export async function allowSessionSweep(event: H3Event, db: Db): Promise<void> {
  const raw = getCookie(event, SESSION_COOKIE);
  if (!raw) return;
  await db.update(sessions).set({ sweepOk: true }).where(eq(sessions.tokenHash, sha256Hex(raw)));
}

/**
 * Resolve the signed-in user from the request's cookie, or null.
 *
 * Refreshes a session that's more than SESSION_REFRESH_AFTER_MS old (sliding
 * expiry: someone who uses the app keeps their session; someone who doesn't is
 * logged out after 90 quiet days). The refresh is best-effort — a failed bump
 * must not fail the request that carried it.
 */
export async function resolveSession(event: H3Event): Promise<ResolvedUser | null> {
  const raw = getCookie(event, SESSION_COOKIE);
  if (!raw) return null;
  const hash = sha256Hex(raw);
  const db = await useAccountDb();
  const now = new Date();
  const rows = await db
    .select({
      sessionId: sessions.id,
      lastUsedAt: sessions.lastUsedAt,
      expiresAt: sessions.expiresAt,
      sweepOk: sessions.sweepOk,
      id: users.id,
      email: users.email,
      displayName: users.displayName,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hash), gt(sessions.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const owner = sessionOwnerMarker(hash);
  if (now.getTime() - new Date(row.lastUsedAt).getTime() > SESSION_REFRESH_AFTER_MS) {
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await Promise.all([
      db
        .update(sessions)
        .set({ lastUsedAt: now, expiresAt })
        .where(eq(sessions.id, row.sessionId))
        .catch(() => {}),
      db
        .update(users)
        .set({ lastSeenAt: now })
        .where(eq(users.id, row.id))
        .catch(() => {}),
    ]);
    // AND RE-SET THE COOKIES. Sliding the row alone slides nothing the user can
    // feel: the browser still drops the cookie 90 days after SIGN-IN, so someone
    // who uses Mahonia every week is signed out on day 90 while holding a session
    // the server considers perfectly valid — and the hint cookie expires with it,
    // so the app doesn't even ask.
    setSessionCookies(event, raw, expiresAt);
  } else if (getCookie(event, SESSION_OWNER_COOKIE) !== owner) {
    // Sessions created before this marker existed acquire it on their next read.
    // Do not reissue the credential or write the database for that migration.
    setCookie(event, SESSION_OWNER_COOKIE, owner, cookieOpts(event, row.expiresAt, false));
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName ?? null,
    owner,
    sweep: row.sweepOk,
    account: accountMarker(row),
  };
}

/**
 * The three lines every endpoint answering with one person's own data opens with,
 * in this order: keep it out of search results, never cache it, throttle on
 * `action`. Headers first, so a 429 carries them too.
 *
 * Narrow in the way requireAccount is (see the argument there and in http.ts): no
 * caller goes near requireAdmin, none needs its limit before its cache headers,
 * and none limits twice. What comes AFTER differs per endpoint (a session, a
 * vault, an edit capability, nothing at all), so that stays at the call site.
 */
export async function openPrivate(event: H3Event, action: RateLimitAction): Promise<void> {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, action);
}

/**
 * The preamble every session-gated ACCOUNT endpoint opens with, in the order
 * they all used to spell out by hand: keep it out of search results, never
 * cache it, throttle on `action`, resolve the session or 401, and hand back the
 * connection with the account schema ensured.
 *
 * http.ts argues against a general headers-plus-rate-limit wrapper, and that
 * argument stands: it is about requireAdmin charging the admin budget twice and
 * the catalog routes needing their limit BEFORE their cache headers. This is
 * narrower than that wrapper — only the endpoints that need a signed-in account,
 * none of which go near requireAdmin, and all of which set both headers first.
 * Ten handlers spelling the same five lines is exactly the drift such a bundle
 * exists to stop (one of them had quietly dropped setPrivate).
 */
export async function requireAccount(
  event: H3Event,
  action: RateLimitAction,
): Promise<{ user: ResolvedUser; db: Db }> {
  await openPrivate(event, action);
  const user = await resolveSession(event);
  if (!user) throw createError({ statusCode: 401, statusMessage: "Sign in required" });
  const db = await useAccountDb();
  return { user, db };
}

/** The clear-side twin of setSessionCookies, and for the same reason: all three
 *  cookies drop together, so a sign-out can never leave the hint behind
 *  claiming a session that's gone. */
function clearSessionCookies(event: H3Event): void {
  deleteCookie(event, SESSION_COOKIE, { path: "/" });
  deleteCookie(event, SESSION_HINT_COOKIE, { path: "/" });
  deleteCookie(event, SESSION_OWNER_COOKIE, { path: "/" });
}

/** Sign out: drop the session row (so the cookie is dead even if it's already been
 *  copied elsewhere) and clear the cookie. */
export async function endSession(event: H3Event): Promise<void> {
  const raw = getCookie(event, SESSION_COOKIE);
  clearSessionCookies(event);
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
  const gone = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  clearSessionCookies(event);
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
  // three unrelated tables, so three statements at once
  await Promise.all([
    db.delete(sessions).where(lt(sessions.expiresAt, now)),
    // the connector's authorization codes live a minute; the ones nobody redeemed go
    // with the same sweep rather than their own
    db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, now)),
    db
      .delete(authTokens)
      .where(
        or(
          lt(authTokens.expiresAt, now),
          // a consumed link is spent the moment it's redeemed, but keep it briefly so
          // a user double-clicking their link gets "already used" rather than a bare
          // "unknown link" while the first click's session is still being set up.
          // An unconsumed link's NULL compares as NULL, never true, so it is left alone.
          lt(authTokens.consumedAt, new Date(now.getTime() - MAGIC_LINK_TTL_MS)),
        ),
      ),
  ]);
}
