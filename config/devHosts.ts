/**
 * The extra Host headers a trusted local proxy may send to Vite during
 * development. Kept out of the VITE_ namespace so it stays server-only, and out
 * of Vite's __VITE_* escape hatch because Nuxt's dotenv loader deliberately
 * ignores underscore-prefixed entries in `.env` files.
 */
export function parseDevAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((host) => host.trim()).filter(Boolean))];
}
