// The card for a shared My Gear link (/og/g/{code}), drawn by the same template as a
// list's card (server/utils/ogCard.ts draws any OgCardModel). Its own module, apart from
// shared/ogCard.ts, because that one rides on the editor's chunks (useListOgCard) and this
// needs My Gear's grouping, which the editor has no use for.
import { drawableOr, type OgCardModel } from "./ogCard";
import { formatCount, pluralNoun } from "./tidyText";
import { groupVaultByKind } from "./vaultView";
import { sharedGearCounts, sharedGearTitle, type SharedGear } from "./vaultShare";

/**
 * Its big figure is how many pieces, not a weight: nobody carries everything they own at
 * once, which is why My Gear dropped its own total (2026-11-08), and a closet's sum would
 * answer no question. The small figures are the kinds it holds most of, as the page's
 * sections file them (three at most, so the line fits), then the kits.
 */
export function gearCardModel(gear: SharedGear): OgCardModel {
  const { pieces, kits } = sharedGearCounts(gear);
  const kinds = groupVaultByKind(gear.items.filter((e) => e.kind !== "kit"))
    .sort((a, b) => b.entries.length - a.entries.length)
    .slice(0, 3)
    .map((s) => ({ label: s.label, value: formatCount(s.entries.length) }));
  // the owner's name filtered first: filtering the whole title instead left a name the
  // font can't draw as a bare "’s gear"
  const owner = gear.owner ? drawableOr(gear.owner, "") : "";
  return {
    title: sharedGearTitle(owner ? { owner } : {}),
    big: { value: formatCount(pieces), unit: pluralNoun(pieces, "piece") },
    chips: [...kinds, ...(kits ? [{ label: "Kits", value: formatCount(kits) }] : [])],
  };
}
