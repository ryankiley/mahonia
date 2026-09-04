// The editor's social-card copy — one rule for both the SSR <head> in
// /e/[code] (JS-less unfurl bots) and the editor's client-side tab/share
// card, so the two surfaces can't drift.
//
// Lives apart from utils/site.ts ON PURPOSE: site.ts is consumed by the root
// app.vue (entry chunk), and editorSeo pulls shared/weights — co-locating them
// hauled the whole weights module into the entry/framework chunk (+1.7 KB br,
// blowing the largest-chunk budget). Here it rides only the /e route chunks,
// which already include weights.

import { SITE_DESCRIPTION } from "~~/shared/site";
import type { Totals, Unit } from "~~/shared/types";
import { formatWeightAuto, unitSystem } from "~~/shared/weights";

// The default "Untitled list" (or empty) is "not named" — an unnamed list keeps
// the generic card rather than advertising "Untitled list". An empty `name`
// signals "use the generic title".
export function editorSeo(
  title: string | undefined,
  totals: Totals | null,
  displayUnit?: Unit,
): { name: string; desc: string } {
  const t = title?.trim();
  const name = t && t !== "Untitled list" ? t : "";
  if (!name) return { name, desc: SITE_DESCRIPTION };
  if (!totals) return { name, desc: `${name}, a packing list on Mahonia.` };
  const bits = [`${totals.itemCount} items`];
  // owner's system, matching the card image this text unfurls beside — the same
  // rule the read views' description follows (see ogCardModel's policy note)
  if (totals.hasWeights)
    bits.push(`${formatWeightAuto(totals.baseMg, { system: unitSystem(displayUnit) })} base weight`);
  return { name, desc: `${name}, a packing list (${bits.join(" · ")}) on Mahonia.` };
}
