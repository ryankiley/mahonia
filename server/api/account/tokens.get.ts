import { defineEventHandler } from "h3";
import { listAccessTokens } from "../../utils/accessTokens";
import { requireAccount } from "../../utils/authSession";

// The account's assistant credentials, for the account page's list: the tokens
// minted by hand and the apps that signed in, each with its label, scope, when made
// and when last used. Never a value — nothing stored could produce one.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "account");
  return { tokens: await listAccessTokens(db, user.id) };
});
