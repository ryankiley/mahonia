import { defineEventHandler, setHeader } from "h3";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { requireVault } from "../../utils/vaultAuth";
import { setVaultItemPrice } from "../../utils/vaultRepo";
import { normalizeCurrency } from "../../../shared/money";

// Record what a piece of gear cost.
//
// The vault is the right home for a price: it's a fact about the thing you own,
// not about any one list, so it belongs with the gear rather than being retyped
// into every list the item appears in.
//
// `priceCents: null` clears it. Scoped by vaultId at the repo layer, so an id from
// another vault matches nothing and returns `{ ok: false }` — the same answer as an
// id that doesn't exist.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "vault-write");
  const { db, vaultId, currency: stored } = await requireVault(event);

  const body = await readJsonBodyCapped<{ id?: unknown; priceCents?: unknown }>(event, 2_000);
  const id = Number.isInteger(body?.id) ? (body.id as number) : null;
  if (id == null) return { ok: false };

  // null clears; anything non-integer is a malformed request, not a clear
  const priceCents =
    body?.priceCents === null
      ? null
      : Number.isInteger(body?.priceCents)
        ? (body.priceCents as number)
        : undefined;
  if (priceCents === undefined) return { ok: false };

  // stamped with the vault's currency, resolved in requireVault, so the figure
  // carries its unit with it without a second round trip
  return { ok: await setVaultItemPrice(db, vaultId, id, priceCents, normalizeCurrency(stored)) };
});
