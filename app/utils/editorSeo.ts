// The editor's social-card copy — one rule for both the SSR <head> in
// /e/[code] (JS-less unfurl bots) and the editor's client-side tab/share
// card, so the two surfaces can't drift.
//
// Lives apart from utils/site.ts ON PURPOSE: site.ts is consumed by the root
// app.vue (entry chunk), and editorSeo pulls shared/weights — co-locating them
// hauled the whole weights module into the entry/framework chunk (+1.7 KB br,
// blowing the largest-chunk budget). Here it rides only the /e route chunks,
// which already include weights.

import type { Totals } from "~~/shared/types";
import { formatWeightAuto } from "~~/shared/weights";

export const GENERIC_TITLE = "Mahonia — pack lists, weighed";
export const GENERIC_DESC = "Make a packing list, see what it weighs, share it. No login.";

// The default "Untitled list" (or empty) is "not named" — an unnamed list keeps
// the generic card rather than advertising "Untitled list". An empty `name`
// signals "use the generic title".
export function editorSeo(
  title: string | undefined,
  totals: Totals | null,
): { name: string; desc: string } {
  const t = title?.trim();
  const name = t && t !== "Untitled list" ? t : "";
  if (!name) return { name, desc: GENERIC_DESC };
  if (!totals) return { name, desc: `${name}, a packing list on Mahonia.` };
  const bits = [`${totals.itemCount} items`];
  if (totals.hasWeights) bits.push(`${formatWeightAuto(totals.baseMg)} base weight`);
  return { name, desc: `${name}, a packing list (${bits.join(" · ")}) on Mahonia.` };
}
