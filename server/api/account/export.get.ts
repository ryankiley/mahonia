import { defineEventHandler, setHeader } from "h3";
import { requireAccount } from "../../utils/authSession";
import { useVaultDb } from "../../utils/db";
import { exportClaimedLists } from "../../utils/listRepo";
import { touchVaultByUser } from "../../utils/vaultAuth";
import { listVaultFolders, listVaultItems } from "../../utils/vaultRepo";
import { everythingExport } from "../../../shared/exporters/everything";

// Take your data with you: every list this account has claimed, in full, plus My Gear,
// as one JSON document. The shapes are the existing ones (shared/exporters/everything).
//
// Session-gated like the delete beside it, on its own tight budget: this reads every
// claimed list's whole content in one request, which is the most a single call here
// can cost, and nobody needs it twice a minute. `private, no-store` comes with
// requireAccount, since this is one person's everything.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "account-export");
  await useVaultDb(); // the vault tables are ensured separately, see db.ts
  // a fresh account has no vault row until its first capture: an empty gear half,
  // not an error, the same reading the /gear page makes
  const vaultId = await touchVaultByUser(db, user.id);
  const [lists, items, folders] = await Promise.all([
    exportClaimedLists(db, user.id),
    vaultId == null ? Promise.resolve([]) : listVaultItems(db, vaultId),
    vaultId == null ? Promise.resolve([]) : listVaultFolders(db, vaultId),
  ]);
  // a download, by name: the browser saves it rather than showing it, and the date
  // in the name is the one fact a person wants when they find the file later
  const today = new Date().toISOString().slice(0, 10);
  setHeader(event, "Content-Disposition", `attachment; filename="mahonia-export-${today}.json"`);
  return everythingExport(lists, { items, folders }, new Date().toISOString());
});
