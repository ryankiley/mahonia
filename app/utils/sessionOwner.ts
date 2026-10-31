import { SESSION_OWNER_COOKIE, SESSION_OWNER_PATTERN } from "~~/shared/session";

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
