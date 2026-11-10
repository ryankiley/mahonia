import { defineEventHandler } from "h3";
import { allowSessionSweep, requireAccount } from "../../utils/authSession";
import { refuseCrossSite } from "../../utils/origin";

// "Add this browser's lists to my account": the yes a confirmed sign-in waits for
// before its lists follow it (see startSession). It only records the answer on
// the session; the browser's own sweep does the attaching, as it always has. Our
// own page only, like the sign-in it finishes.
export default defineEventHandler(async (event) => {
  refuseCrossSite(event);
  const { db } = await requireAccount(event, "auth-me");
  await allowSessionSweep(event, db);
  return { ok: true as const };
});
