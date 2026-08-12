import { defineEventHandler } from "h3";
import { requireUser } from "../../../utils/authSession";
import { listPasskeys } from "../../../utils/credentialRepo";
import { useAccountDb } from "../../../utils/db";
import { rateLimit } from "../../../utils/rateLimit";
import { setNoIndex, setPrivate } from "../../../utils/http";

// The passkeys on this account, so they can be reviewed and revoked. Metadata
// only — label and timestamps; the public key isn't useful to show and the
// private half doesn't exist here.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "passkey");
  const user = await requireUser(event);
  const db = await useAccountDb();
  return { passkeys: await listPasskeys(db, user.id) };
});
