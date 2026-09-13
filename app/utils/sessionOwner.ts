import { SESSION_OWNER_COOKIE } from "~~/shared/session";

/** The account that browser-local session data belongs to, if the server set it. */
export function sessionCacheOwner(): number | null {
  if (!import.meta.client) return null;
  const value = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${SESSION_OWNER_COOKIE}=`))
    ?.slice(SESSION_OWNER_COOKIE.length + 1);
  const owner = Number(value);
  return Number.isSafeInteger(owner) && owner > 0 ? owner : null;
}
