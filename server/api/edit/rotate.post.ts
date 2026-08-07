import { createError, defineEventHandler, setHeader } from "h3";
import { rotateEditHash } from "../../utils/listRepo";
import { requireEditHash } from "../../utils/editAuth";
import { resolveSession } from "../../utils/authSession";
import { rateLimit } from "../../utils/rateLimit";

// Revoke + reissue the edit token (e.g. after a leak). The old token 404s after.
// The response hands the caller the NEW raw token either way in — including a
// session-authorised rotate of a claimed list, which is how a device that never
// held the edit link mints itself a fresh one.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "rotate");
  const hash = await requireEditHash(event);
  // The rotator's own claim survives the rotation's claim-clearing (see
  // rotateEditHash: keepUserId is "whoever is doing the rotating"). Resolved here
  // for BOTH paths — a signed-in owner rotating via their bearer token deserves
  // the same survival as one rotating via a claim.
  const user = await resolveSession(event);
  const next = await rotateEditHash(hash, user?.id);
  if (!next) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return { editToken: next };
});
