import { SESSION_OWNER_COOKIE, SESSION_OWNER_PATTERN } from "~~/shared/session";

/** The account that browser-local session data belongs to, if the server set it —
 *  the marker itself, or null when there is none (or it isn't one). */
export function sessionCacheOwner(): string | null {
  if (!import.meta.client) return null;
  const value = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${SESSION_OWNER_COOKIE}=`))
    ?.slice(SESSION_OWNER_COOKIE.length + 1);
  return value && SESSION_OWNER_PATTERN.test(value) ? value : null;
}
