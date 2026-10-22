import { defineEventHandler } from "h3";
import { listAccessTokens } from "../../utils/accessTokens";
import { requireAccount } from "../../utils/authSession";

// The assistant tokens on this account, so they can be reviewed and revoked.
// Metadata only: the value was shown once, when it was made, and only its hash is kept.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "account");
  return { tokens: await listAccessTokens(db, user.id) };
});
