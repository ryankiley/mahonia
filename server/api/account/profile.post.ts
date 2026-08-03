import { defineEventHandler, setHeader } from "h3";
import { eq } from "drizzle-orm";
import { requireUser } from "../../utils/authSession";
import { useAccountDb } from "../../utils/db";
import { users } from "../../db/schema";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";

/** Cap on a display name. Long enough for a real name or a trail name, short
 *  enough that a byline can't become a billboard. */
const DISPLAY_NAME_MAX = 40;

/**
 * Strip anything that would let a name misbehave where it's rendered.
 *
 * This is the one account field shown on PUBLIC pages, so it gets treated like
 * user content rather than a setting: control characters and the invisible
 * formatting ranges (zero-width, bidi overrides, the ideographic space) collapse
 * to ordinary spaces, runs of whitespace fold to one, and the result is trimmed
 * and capped. Vue escapes markup on render — this is about layout and legibility,
 * not injection.
 */
function cleanDisplayName(raw: string): string {
  return (
    raw
      // C0/C1 controls, zero-width + word joiner, bidi embedding/overrides and
      // isolates, the ideographic space and BOM. Written as escapes on purpose:
      // the literal characters are invisible in source, and several are outright
      // invalid inside a regex literal.
      .replace(
        /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\u3000\uFEFF]/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, DISPLAY_NAME_MAX)
  );
}

// The account's one setting: the display name — the ONLY part of an account that
// is ever public. An empty string clears it and returns you to anonymous; only a
// field actually present in the body is written.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "account");
  const user = await requireUser(event);

  const body = await readJsonBodyCapped<{ displayName?: unknown }>(
    event,
    2_000,
  );

  const patch: { displayName?: string | null } = {};
  if (typeof body?.displayName === "string") {
    patch.displayName = cleanDisplayName(body.displayName) || null;
  }
  const db = await useAccountDb();
  if (Object.keys(patch).length) {
    await db.update(users).set(patch).where(eq(users.id, user.id));
  }

  const row = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  return {
    ok: true,
    displayName: row[0]?.displayName ?? null,
  };
});
