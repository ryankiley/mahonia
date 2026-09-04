import { defineEventHandler } from "h3";
import { readJsonBodyCapped, setNoIndex, setPrivate } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { resolveOrMintVault } from "../../utils/vaultAuth";
import { captureVaultItemsReporting } from "../../utils/vaultRepo";
import { VAULT_CAPTURE_MAX, type VaultCapture } from "../../../shared/vault";

// Fold the gear in an open list into the holder's vault.
//
// The client sends the list's whole capture set (deduped, fingerprinted, and only
// when that fingerprint changed — see app/composables/useVault.ts), not a delta.
// Sending the full set makes the endpoint idempotent: a replayed or duplicated
// request re-upserts the same rows and changes nothing but `times_seen`, so the
// offline queue and a flaky connection need no reconciliation logic.
//
// This is the ONE endpoint that will mint a vault, and only for a signed-in
// caller who doesn't have one yet — a vault comes into being the first time you
// have gear worth remembering, the same way a list isn't created until it has real
// content. The vault is identified by the account, so there is no capability to
// hand out and nothing for the client to store.
//
// What DOES come back is which keys are now live, because "I sent it" and "the
// vault holds it" are not the same claim and the client renders off the second
// one. The upsert deliberately leaves a tombstone tombstoned, and it drops new
// keys past VAULT_ITEMS_MAX in silence — so a client that assumed 2xx meant
// stored would hide the save button on gear the vault had just refused, with the
// row's own covered guard making a second press a no-op.
//
// A signed-out capture is refused rather than dropped: there is no owner to file
// the gear under, and inventing an anonymous vault would put it somewhere nobody
// could reach again. That refusal is silent by design — capture runs in the
// background while you build a list, and it must never surface an error over the
// list you're actually working on.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "vault-capture");

  // 200 rows of gear with their optional URLs — generous for the cap above, still
  // far below the platform body limit
  const body = await readJsonBodyCapped<{ items?: unknown }>(event, 256_000);
  const items = Array.isArray(body?.items)
    ? (body.items.filter((i) => i && typeof i === "object") as VaultCapture[]).slice(
        0,
        VAULT_CAPTURE_MAX,
      )
    : [];
  // Nothing to store — and deliberately checked BEFORE the mint, so an editor that
  // is open but empty never brings a vault into existence.
  if (!items.length) return { ok: true, captured: 0, keys: [] };

  // The beacon carries no header — `navigator.sendBeacon` can't set one — but it
  // is same-origin, so the session cookie rides along and IS the capability. That
  // is the whole reason this endpoint needed a body token under link ownership and
  // doesn't now.
  const { db, vaultId } = await resolveOrMintVault(event);
  // The write reports its own result — no second query, and no chance of asking
  // about a key the server spelled differently than the client did (sanitize
  // re-derives normKey from the tidied text).
  const { keys, full } = await captureVaultItemsReporting(db, vaultId, items);
  // `full` only ever means "new gear was refused for space". The automatic path
  // ignores it (capture is a side effect of editing, and must never put an error
  // over the list); a hand press needs it, because "the vault is full" and "you
  // removed this gear" are fixed in different places.
  return { ok: true, captured: keys.length, keys, full };
});
