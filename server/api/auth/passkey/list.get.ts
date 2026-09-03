import { defineEventHandler } from "h3";
import { requireAccount } from "../../../utils/authSession";
import { listPasskeys } from "../../../utils/credentialRepo";

// The passkeys on this account, so they can be reviewed and revoked. Metadata
// only — label and timestamps; the public key isn't useful to show and the
// private half doesn't exist here.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "passkey");
  return { passkeys: await listPasskeys(db, user.id) };
});
