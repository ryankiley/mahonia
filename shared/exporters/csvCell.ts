// One CSV cell, escaped and de-fanged — the two rules every exporter here shares.
//
// Its own module because both exporters need them and neither should own them: the
// formula guard is a security rule (below), and a second hand-written copy is a
// second thing to forget when the rule changes. The list exporter had them
// module-private until the gear exporter needed the same two.

import type { Unit } from "../types";

// A leading =, +, -, @, or a control char (tab/CR) makes a spreadsheet treat the
// cell as a formula/command (CSV injection / DDE) when the export is opened in
// Excel/Sheets — dangerous because the content can come from another user (a
// shared edit link, or a LighterPack import). Neutralize by prefixing a single
// quote, the standard mitigation; stripFormulaGuard() removes it again on import
// so our own round-trip is lossless.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

const guardFormula = (s: string) => (FORMULA_LEAD.test(s) ? `'${s}` : s);

export function stripFormulaGuard(s: string): string {
  return s.length > 1 && s[0] === "'" && FORMULA_LEAD.test(s.slice(1)) ? s.slice(1) : s;
}

/** A value as one CSV field: guarded, then quoted only when it has to be. */
export function csvCell(v: unknown): string {
  const s = guardFormula(String(v ?? ""));
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Decimals each unit's weight is written with, in the list's CSV and in My Gear's.
// Enough that toMg() rounds the value back to the milligrams it came from, so an
// export/import round trip is lossless in every unit. Zero decimals for grams claims
// a 499 mg row weighs nothing, while formatWeight goes out of its way to render "<1 g"
// on the same data, on the stated reasoning that a real weight rounding to zero "must
// NOT read as 0". Trailing zeros never survive the unary `+` at the call sites, so a
// whole-gram weight still exports "1247", not "1247.000".
export const CSV_DECIMALS: Record<Unit, number> = { g: 3, kg: 6, oz: 6, lb: 6 };
