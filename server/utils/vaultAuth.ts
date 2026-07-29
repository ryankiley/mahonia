import type { H3Event } from "h3";
import { createError, getHeader } from "h3";
import { eq, sql } from "drizzle-orm";
import { vaults } from "../db/schema";
import { useVaultDb } from "./db";
import { randomEditToken, sha256Hex } from "./tokens";

/**
 * The ONE place a vault token becomes a vault id. Every vault endpoint goes
 * through here, so the authorisation rule is written down once and a new endpoint
 * can't invent a looser one — the same discipline `requireEditToken` gives lists.
 *
 * A vault is owned by possession of its token, exactly like a list's edit link.
 * The token travels in the Authorization header (NOT the URL path) so it stays out
 * of server logs and the Referer, and the raw value is never stored — only
 * sha256. There is no account, no session cookie, and no user row anywhere in this
 * path.
 */

type Db = Awaited<ReturnType<typeof useVaultDb>>;

/** The raw token off the request, or "" — presence is the caller's to interpret. */
export function bearer(event: H3Event): string {
  const header = getHeader(event, "authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * The token a caller supplied, header first.
 *
 * `fallback` exists for exactly one caller: the capture beacon. `navigator
 * .sendBeacon` is the only way to get a pending capture out as the page unloads,
 * and it cannot set headers — an account-shaped design would lean on the session
 * cookie riding along, which a bearer token has no equivalent of. So capture (and
 * only capture) also accepts the token in its JSON body. That's a POST body, not a
 * URL, so it stays out of logs and the Referer exactly as the header does.
 */
function suppliedToken(event: H3Event, fallback?: string): string {
  return bearer(event) || (typeof fallback === "string" ? fallback.trim() : "");
}

/**
 * Resolve the request's vault, or 401.
 *
 * An absent token is 401 (you sent no capability). An unresolvable one is ALSO
 * 401, deliberately, not 404: a 404 here would confirm that some other token does
 * exist, turning the endpoint into an oracle you could walk. The two cases are
 * indistinguishable from outside, which is the point.
 *
 * `last_seen_at` is bumped on every resolve so an abandoned vault can be reaped on
 * the same schedule as an abandoned list, instead of accumulating forever.
 */
export async function requireVault(
  event: H3Event,
  bodyToken?: string,
): Promise<{ db: Db; vaultId: number }> {
  const token = suppliedToken(event, bodyToken);
  if (!token) throw createError({ statusCode: 401, statusMessage: "Missing vault capability" });

  const db = await useVaultDb();
  const vaultId = await touchVaultByToken(db, token);
  if (vaultId == null) throw createError({ statusCode: 401, statusMessage: "Unknown vault" });
  return { db, vaultId };
}

/**
 * Resolve a token AND mark the vault as used: bump last_seen_at, and clear any
 * soft-delete the reaper had set.
 *
 * That second half is the REVIVE, and it's the safety net under the whole reaper:
 * a vault whose link resurfaces inside the purge grace comes back simply by being
 * used. There is no separate restore path to remember to call, because the one
 * statement every vault request already runs does it.
 *
 * Split out of requireVault so the rule can be tested without an H3Event — it's
 * the part with actual behaviour in it; what's left up there is error handling.
 */
export async function touchVaultByToken(db: Db, token: string): Promise<number | null> {
  const rows = await db
    .update(vaults)
    .set({ lastSeenAt: sql`now()`, deletedAt: null })
    .where(eq(vaults.tokenHash, sha256Hex(token)))
    .returning();
  return rows[0]?.id ?? null;
}

/**
 * Resolve a token to a vault id, or null — WITHOUT throwing, and without bumping
 * last_seen_at.
 *
 * For the one caller that holds a token it does not need to be authorised BY: the
 * adopt merge, whose authority comes from the destination vault in the header and
 * which names the source vault in its body. A stale source token there is an
 * ordinary outcome (you forgot this device's vault, or already merged it), not a
 * 401 — requireVault's throw would turn a no-op into an error the page has to
 * explain.
 *
 * NOT a way around requireVault: it returns an id to code that has already proved
 * possession of something. Nothing routes user input straight into it.
 */
export async function findVaultByToken(db: Db, token: string): Promise<number | null> {
  const clean = (token ?? "").trim();
  if (!clean) return null;
  const rows = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(eq(vaults.tokenHash, sha256Hex(clean)));
  return rows[0]?.id ?? null;
}

/**
 * Mint a brand-new vault and hand back its raw token — the only time that value
 * exists server-side. The caller returns it to the client exactly once; after this
 * the database holds nothing that can reconstruct it.
 *
 * Vaults are minted LAZILY, on the first capture that has something to store, for
 * the same reason a list isn't created until it has real content: opening the
 * editor shouldn't leave a row behind.
 */
export async function mintVault(db: Db): Promise<{ vaultId: number; token: string }> {
  const token = randomEditToken();
  const rows = await db
    .insert(vaults)
    .values({ tokenHash: sha256Hex(token) })
    .returning();
  return { vaultId: rows[0]!.id, token };
}

/**
 * Resolve the request's vault, minting one if the request carries no token.
 *
 * ONLY for capture — the write that happens automatically as you build a list, and
 * the one path where "there isn't a vault yet" is the normal first case rather than
 * an error. A token that is present but unknown still 401s: minting a replacement
 * there would silently strand whatever the holder thought they had, and quietly
 * hand back a different vault under the same name.
 */
export async function resolveOrMintVault(
  event: H3Event,
  bodyToken?: string,
): Promise<{ db: Db; vaultId: number; mintedToken?: string }> {
  if (suppliedToken(event, bodyToken)) return requireVault(event, bodyToken);
  const db = await useVaultDb();
  const { vaultId, token } = await mintVault(db);
  return { db, vaultId, mintedToken: token };
}
