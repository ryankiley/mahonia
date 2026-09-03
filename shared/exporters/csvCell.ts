// One CSV cell, escaped and de-fanged — the two rules every exporter here shares.
//
// Its own module because both exporters need them and neither should own them: the
// formula guard is a security rule (below), and a second hand-written copy is a
// second thing to forget when the rule changes. The list exporter had them
// module-private until the gear exporter needed the same two.

// A leading =, +, -, @, or a control char (tab/CR) makes a spreadsheet treat the
// cell as a formula/command (CSV injection / DDE) when the export is opened in
// Excel/Sheets — dangerous because the content can come from another user (a
// shared edit link, or a LighterPack import). Neutralize by prefixing a single
// quote, the standard mitigation; stripFormulaGuard() removes it again on import
// so our own round-trip is lossless.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export const guardFormula = (s: string) => (FORMULA_LEAD.test(s) ? `'${s}` : s);

export function stripFormulaGuard(s: string): string {
  return s.length > 1 && s[0] === "'" && FORMULA_LEAD.test(s.slice(1)) ? s.slice(1) : s;
}

/** A value as one CSV field: guarded, then quoted only when it has to be. */
export function csvCell(v: unknown): string {
  const s = guardFormula(String(v ?? ""));
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
