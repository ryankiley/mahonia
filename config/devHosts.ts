/**
 * The extra Host headers a trusted local proxy may send to Vite during
 * development — read only when the dev server sits on a loopback host; see the
 * note in nuxt.config.ts. Kept out of the VITE_ namespace so it stays server-only,
 * and out of Vite's __VITE_* escape hatch because Nuxt's dotenv loader deliberately
 * ignores underscore-prefixed entries in `.env` files. Entries go to Vite as
 * written: it matches a hostname exactly (port stripped from the request, not from
 * the entry) or, with a leading dot, as a suffix.
 */
export function parseDevAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((host) => host.trim()).filter(Boolean))];
}
