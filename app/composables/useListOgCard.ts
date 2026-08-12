import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, ogCardAlt, ogCardModel } from "~~/shared/ogCard";
import type { ListSnapshot, Totals } from "~~/shared/types";

// One seam for "this page's social card is this list's card" — the og:image
// tags for a per-list card, set identically on every surface that unfurls one
// (/s and /l via useReadonlyListSeo, /e/[code] directly). The next card tag
// gets added here once, not found-and-missed across pages; the same argument
// useReadonlyListSeo makes for owning the text half.
//
// While the source is null (list not yet resolved, or not found) every getter
// yields undefined and unhead keeps the app-level static card from app.vue — a
// bad link unfurls as the site. Width/height are unconditional: the static
// fallback is the same 1200×630, so the values hold either way.
export function useListOgCard(
  source: () => { path: string; list: ListSnapshot; totals: Totals } | null,
): void {
  const origin = useSiteOrigin();
  const card = computed(() => {
    const s = source();
    if (!s) return null;
    return { url: `${origin}${s.path}`, alt: ogCardAlt(ogCardModel(s.list, s.totals)) };
  });
  useSeoMeta({
    ogImage: () => card.value?.url,
    ogImageAlt: () => card.value?.alt,
    ogImageWidth: OG_IMAGE_WIDTH,
    ogImageHeight: OG_IMAGE_HEIGHT,
    // the one dimension that genuinely differs from the static fallback (a jpeg)
    ogImageType: () => (card.value ? "image/png" : undefined),
    // app.vue sets a static twitterImage site-wide; without this override the
    // list pages would keep it and Twitter would ignore the og fallback
    twitterImage: () => card.value?.url,
  });
}
