import type { Totals } from "../../shared/types";

/** A zeroed Totals with overrides — the fixture the weights and og-card suites
 *  share (build rollups by hand, not through computeTotals, so a test states
 *  exactly the shape it means to exercise). */
export const totals = (over: Partial<Totals>): Totals => ({
  totalMg: 0,
  baseMg: 0,
  wornMg: 0,
  consumableMg: 0,
  carriedMg: 0,
  itemCount: 0,
  hasWeights: false,
  kcalTotal: 0,
  hasKcal: false,
  ...over,
});
