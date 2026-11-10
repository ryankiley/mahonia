import { SESSION_OWNER_COOKIE, SESSION_OWNER_PATTERN } from "~~/shared/session";
import { forget, recall, remember } from "./remember";

/** One readable cookie's value, or null — the session's two client-visible markers
 *  (the owner below, the signed-in hint in useSession) are read through this. */
export function readCookie(name: string): string | null {
  if (!import.meta.client) return null;
  return (
    document.cookie
      .split("; ")
      .find((cookie) => cookie.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null
  );
}

/** The account that browser-local session data belongs to, if the server set it —
 *  the marker itself, or null when there is none (or it isn't one). */
export function sessionCacheOwner(): string | null {
  const value = readCookie(SESSION_OWNER_COOKIE);
  return value && SESSION_OWNER_PATTERN.test(value) ? value : null;
}

/** A browser-local cache's key for one account: `base.owner`, or null with no owner to
 *  key it by, in which case nothing is kept or read. The one rule every per-account memo
 *  follows (the switcher's rows and opens, My Gear's offline copy), so one account's
 *  cache can never be read under another's marker. */
export const ownedKey = (base: string, owner: string | null): string | null =>
  owner === null ? null : `${base}.${owner}`;

/**
 * EVERY per-account memo this browser keeps in localStorage, by the base of its key.
 *
 * The one list, so that letting go of an account is one call (forgetOwned) and not
 * a line per memo for whoever adds the next one to remember. Each used to be
 * forgotten by its own function, called from useSession; a memo left off that list
 * simply stayed.
 *
 * And so the ones nobody forgot can be found (sweepOwned). An owner marker is new
 * with every sign-in and never comes back, so a memo under any marker but the
 * current one can never be read again. They piled up all the same: a session that
 * was replaced while the app wasn't open to see it go left its rows, its ledger
 * and its whole copy of My Gear behind, a set per sign-in.
 */
export const OWNED = {
  /** the registry's "already claimed" fingerprint (useClaimedLists) */
  claimedMark: "gear.claimed.v2",
  /** the account's lists as last read, for the switcher offline (useClaimedLists) */
  claimedRows: "gear.claimed.rows.v2",
  /** which of them this browser has had open, and when (useClaimedLists) */
  claimedOpens: "gear.claimed.opens.v2",
  /** this device's copy of My Gear (useVaultList) */
  gearCopy: "gear.vault.copy.v1",
  /** which account the session belongs to (sessionAccount, below) */
  account: "gear.account.v1",
} as const;

/** Let go of everything kept for `owner`. Part of forgetAccountMemos, run on every
 *  way out of an account. */
export function forgetOwned(owner: string | null): void {
  if (!import.meta.client || owner === null) return;
  for (const base of Object.values(OWNED)) forget(`${base}.${owner}`);
}

/**
 * Drop what was kept for any session but `keep` (null: for any session at all).
 *
 * Strictly the keys this file names: a registered base, a dot, and something
 * shaped like an owner marker. Never by pattern over everything under "gear.",
 * which is also where the lists this browser holds the edit links to are kept.
 */
export function sweepOwned(keep: string | null): void {
  if (!import.meta.client) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      for (const base of Object.values(OWNED)) {
        if (!key.startsWith(`${base}.`)) continue;
        const owner = key.slice(base.length + 1);
        if (owner !== keep && SESSION_OWNER_PATTERN.test(owner)) stale.push(key);
      }
    }
    // after the walk: removing while indexing skips the key that slides into place
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    /* storage blocked: nothing was kept, so nothing to sweep */
  }
}

/** Which account the current session belongs to, as the marker /api/auth/me gave
 *  for it (accountMarker on the server), or null before that answer or signed out.
 *  Kept beside the session's owner marker so it can be read with no network: the
 *  on-device copy of a list opened through the account is filed under it. */
export function sessionAccount(): string | null {
  const key = ownedKey(OWNED.account, sessionCacheOwner());
  return key ? recall(key) : null;
}

export function rememberSessionAccount(owner: string, account: string): void {
  const key = ownedKey(OWNED.account, owner);
  if (key && account) remember(key, account);
}
