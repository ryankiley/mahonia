import { defineEventHandler, setHeader } from "h3";
import { eq } from "drizzle-orm";
import { resolveSession } from "../../utils/authSession";
import { useAccountDb } from "../../utils/db";
import { users } from "../../db/schema";
import { rateLimit } from "../../utils/rateLimit";

// Who am I? `{ user: null }` when signed out — an ordinary answer, not a 401, so
// the client can render the signed-out state without treating it as an error.
//
// Never cached: it varies per cookie, and an edge or browser cache holding one
// user's answer is the classic way to serve someone else's identity.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "auth-me");
  const user = await resolveSession(event);
  if (!user) return { user: null };
  // the display name rides along so the account page and anything that renders a
  // byline read one source rather than each fetching their own
  const db = await useAccountDb();
  const row = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  return {
    user: {
      email: user.email,
      displayName: row[0]?.displayName ?? null,
    },
  };
});
