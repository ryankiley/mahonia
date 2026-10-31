// The vault suites' fixtures: a stored row as /gear reads it (VaultEntry), a folder,
// and the one capture every persistence case starts from. vaultView, vaultImport and
// vaultExport each carried the row and folder factories; vault.test.ts and
// vaultAuth.test.ts between them carried nine copies of the Duplex capture.

import { vaultNormKey, type VaultEntry, type VaultFolder } from "../../shared/vault";

let nextId = 1;

/** A live vault row: a 539 g Duplex, seen once, used and created on fixed dates so a
 *  sort has something to order by. Ids count up across a file. */
export const vaultRow = (over: Partial<VaultEntry> = {}): VaultEntry => ({
  id: nextId++,
  normKey: `k${nextId}`,
  name: "Duplex",
  weightMg: 539_000,
  timesSeen: 1,
  lastUsedAt: "2026-08-01T12:30:00.000Z",
  createdAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

export const vaultFolder = (id: number, name: string): VaultFolder => ({ id, name });

/** The one row every persistence case starts from. */
export const DUPLEX = {
  normKey: vaultNormKey("Zpacks", "Duplex", null),
  brand: "Zpacks",
  name: "Duplex",
  weightMg: 539_000,
} as const;

/** A capture of the Duplex with `over` laid on top, keyed by whatever spelling that
 *  leaves — so `cap({ name: "Quilt" })` is a second piece of gear, not a forged key.
 *  Loosely typed on purpose: the hostile-input cases send a string kcal or a numeric
 *  URL, and the repo is what has to refuse them. */
export const cap = (over: Record<string, unknown> = {}) => {
  const o = { ...DUPLEX, ...over } as Record<string, unknown>;
  const normKey =
    "normKey" in over ? over.normKey : vaultNormKey(o.brand as string | undefined, o.name as string, o.variant as string | undefined);
  return { ...o, normKey } as any;
};
