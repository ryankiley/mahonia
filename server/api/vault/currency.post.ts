import { defineEventHandler, setHeader } from "h3";
import { eq } from "drizzle-orm";
import { vaults } from "../../db/schema";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { requireVault } from "../../utils/vaultAuth";
import { normalizeCurrency } from "../../../shared/money";

// The currency this vault records costs in.
//
// One per VAULT, not per item: /vault shows a running total, and summing mixed
// currencies would be arithmetic on incomparable numbers. Changing it re-labels
// what's already stored rather than converting anything — there are no rates here,
// and inventing one would be worse than showing the figure you typed.
//
// Anything unrecognised normalises to the default rather than 400ing: this is a
// display preference, and a stale or hand-edited value should fall back to
// something sane instead of leaving the vault unusable.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "vault-write");
  const { db, vaultId } = await requireVault(event);

  const body = await readJsonBodyCapped<{ currency?: unknown }>(event, 2_000);
  const currency = normalizeCurrency(body?.currency);
  await db.update(vaults).set({ currency }).where(eq(vaults.id, vaultId));
  return { ok: true, currency };
});
