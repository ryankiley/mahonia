import { defineEventHandler } from "h3";
import { eq } from "drizzle-orm";
import { requireAccount } from "../../utils/authSession";
import { users } from "../../db/schema";
import { cleanLine, readJsonBodyCapped } from "../../utils/http";

/** Cap on a display name. Long enough for a real name or a trail name, short
 *  enough that a byline can't become a billboard. */
const DISPLAY_NAME_MAX = 40;

/**
 * Strip anything that would let a name misbehave where it's rendered.
 *
 * This is the one account field shown on PUBLIC pages, so it gets treated like
 * user content rather than a setting (see cleanLine). Vue escapes markup on
 * render — this is about layout and legibility, not injection.
 */
const cleanDisplayName = (raw: string): string => cleanLine(raw, DISPLAY_NAME_MAX);

// The account's one setting: the display name — the ONLY part of an account that
// is ever public. An empty string clears it and returns you to anonymous; only a
// field actually present in the body is written.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "account");

  const body = await readJsonBodyCapped<{ displayName?: unknown }>(
    event,
    2_000,
  );

  // The write hands the row back (RETURNING), and with nothing to write the name
  // is the one requireAccount's session lookup already read: no second read either way.
  const row =
    typeof body?.displayName === "string"
      ? await db
          .update(users)
          .set({ displayName: cleanDisplayName(body.displayName) || null })
          .where(eq(users.id, user.id))
          .returning({ displayName: users.displayName })
      : [user];
  return {
    ok: true,
    displayName: row[0]?.displayName ?? null,
  };
});
