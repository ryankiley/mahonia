import { defineEventHandler } from "h3";
import { readJsonBodyCapped, setNoIndex, setPrivate } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { resolveOrMintVault } from "../../utils/vaultAuth";
import { importVaultItems, type VaultImportRow } from "../../utils/vaultRepo";
import { VAULT_IMPORT_MAX } from "../../../shared/vault";

// Put a file's worth of gear back — the other end of /gear's two downloads.
//
// The client parses (shared/vaultImport) and sends rows; the server re-derives
// every one of them anyway (vaultRepo's sanitize), so what arrives is treated as
// text somebody typed rather than as a document we wrote. Parsing client-side is
// what keeps a CSV dialect problem out of the server and lets the dialog say what
// it found before anything is sent.
//
// MINTS a vault, like capture does: "restore my backup" has to work on an account
// that has never opened an editor, which is exactly the account a person signs into
// on a new machine.
//
// Adds what's missing and leaves everything else alone (see importVaultItems), so
// this needs no confirmation and no undo — the failure mode a restore actually has
// is a stale backup landing on a curated vault, and the skip is what makes that
// harmless.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "vault-write");

  // Four times the capture cap: this carries a whole vault rather than one list's
  // worth, and a row can hold two URLs and a note.
  const body = await readJsonBodyCapped<{ items?: unknown }>(event, 1_000_000);
  const items = Array.isArray(body?.items)
    ? (body.items.filter((i) => i && typeof i === "object") as VaultImportRow[]).slice(
        0,
        VAULT_IMPORT_MAX,
      )
    : [];
  // Checked before the mint, like capture: an empty file must not bring a vault
  // into existence.
  if (!items.length) return { ok: true, added: 0, skipped: 0 };

  const { db, vaultId } = await resolveOrMintVault(event);
  const { added, skipped } = await importVaultItems(db, vaultId, items);
  return { ok: true, added, skipped };
});
