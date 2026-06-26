import { readBody, type H3Event } from "h3";

/**
 * Read a JSON body that never throws on missing/malformed input — it falls back
 * to `{}`, so every handler can validate its own fields uniformly. Centralizes
 * the `readBody(...).catch(() => ({}))` idiom the mutating endpoints all share.
 */
export async function readJsonBody<T>(event: H3Event): Promise<T> {
  return (await readBody(event).catch(() => ({}))) as T;
}
