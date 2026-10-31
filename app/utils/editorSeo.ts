// The editor's social-card copy — one rule for both the SSR <head> in
// /e/[code] (JS-less unfurl bots) and the editor's client-side tab/share
// card, so the two surfaces can't drift.
//
// Lives apart from utils/site.ts ON PURPOSE: site.ts is consumed by the root
// app.vue (entry chunk), and editorSeo pulls shared/weights — co-locating them
// hauled the whole weights module into the entry/framework chunk (+1.7 KB br,
// blowing the largest-chunk budget). Here it rides only the /e route chunks,
// which already include weights.

import type { Totals, Unit } from "~~/shared/types";
import { listSummaryBits } from "~~/shared/weights";

export const GENERIC_TITLE = "Mahonia — pack lists, weighed";
const GENERIC_DESC = "Make a packing list, see what it weighs, share it. No login needed.";

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
  if (!name) return { name, desc: GENERIC_DESC };
  if (!totals) return { name, desc: `${name}, a packing list on Mahonia.` };
  // the same facts, in the same words, as the read views' description (listSummaryBits)
  return { name, desc: `${name}, a packing list (${listSummaryBits(totals, displayUnit).join(" · ")}) on Mahonia.` };
}
