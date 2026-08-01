import { defineEventHandler, setHeader } from "h3";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { resolveOrMintVault } from "../../utils/vaultAuth";
import { captureVaultItems } from "../../utils/vaultRepo";
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
// content. Nothing comes back but a count: the vault is identified by the account,
// so there is no capability to hand out and nothing for the client to store.
//
// A signed-out capture is refused rather than dropped: there is no owner to file
// the gear under, and inventing an anonymous vault would put it somewhere nobody
// could reach again. That refusal is silent by design — capture runs in the
// background while you build a list, and it must never surface an error over the
// list you're actually working on.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
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
  if (!items.length) return { ok: true, captured: 0 };

  // The beacon carries no header — `navigator.sendBeacon` can't set one — but it
  // is same-origin, so the session cookie rides along and IS the capability. That
  // is the whole reason this endpoint needed a body token under link ownership and
  // doesn't now.
  const { db, vaultId } = await resolveOrMintVault(event);
  const captured = await captureVaultItems(db, vaultId, items);
  return { ok: true, captured };
});
