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
// This is the ONE endpoint that will mint a vault, and only when the request
// carries no token at all — a vault comes into being the first time you have gear
// worth remembering, the same way a list isn't created until it has real content.
// When that happens the freshly minted token comes back as `vaultToken`, the only
// time that value ever leaves the server; the client stores it and sends it from
// then on. A token that IS present but unknown is a 401, not a fresh mint —
// silently handing back a different vault would strand whatever the holder thought
// they had.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "vault-capture");

  // 200 rows of gear with their optional URLs — generous for the cap above, still
  // far below the platform body limit
  const body = await readJsonBodyCapped<{ items?: unknown; vaultToken?: unknown }>(event, 256_000);
  const items = Array.isArray(body?.items)
    ? (body.items.filter((i) => i && typeof i === "object") as VaultCapture[]).slice(
        0,
        VAULT_CAPTURE_MAX,
      )
    : [];
  // Nothing to store — and deliberately checked BEFORE the mint, so an editor that
  // is open but empty never brings a vault into existence.
  if (!items.length) return { ok: true, captured: 0 };

  // the body token is the beacon path's only way to authenticate — see
  // suppliedToken() in vaultAuth for why this one endpoint accepts it
  const bodyToken = typeof body?.vaultToken === "string" ? body.vaultToken : undefined;
  const { db, vaultId, mintedToken } = await resolveOrMintVault(event, bodyToken);
  const captured = await captureVaultItems(db, vaultId, items);
  return { ok: true, captured, ...(mintedToken ? { vaultToken: mintedToken } : {}) };
});
