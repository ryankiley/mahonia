<script setup lang="ts">
// A catalog product's page: /catalog/<brand>/<product>. The reference page for one
// thing the catalog knows — its variants with each one's cited weight and the maker's
// own words for it — and the way in: "Pack this" opens the editor with the row added.
//
// Rendered from the committed CSV, never the database: every one of these pages is
// prerendered at build (nuxt.config's /catalog rule and its prerender:routes hook)
// and served as a static file, so a crawler walking all of them costs nothing at
// runtime. That is also why nothing here is per-visitor: no stored unit preference,
// no dates, no session — the HTML is the same for everyone, so it hydrates clean.
//
// No recommending on a reference page: no "lighter than", no neighbours, no counts.
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { pageWeightRange, type CatalogPage } from "~~/shared/catalogPages";
import { displayQuote } from "~~/shared/catalogQuote";
import { CATALOG_SLUG_SEGMENT } from "~~/shared/catalogSlug";
import { displayHost, safeUrl } from "~~/shared/trailLink";
import { autoUnit, formatWeight, MG_PER_UNIT } from "~~/shared/weights";
import type { Unit } from "~~/shared/types";

const route = useRoute();
const brand = computed(() => String(route.params.brand || ""));
const product = computed(() => String(route.params.product || ""));
const slug = computed(() => `${brand.value}/${product.value}`);

// A malformed address never reaches the API: the segment grammar is the slug rule's
// own (shared/catalogSlug.ts), so "x-mid-pro-2+" is a 404 here, not a lookup.
if (!CATALOG_SLUG_SEGMENT.test(brand.value) || !CATALOG_SLUG_SEGMENT.test(product.value)) {
  throw createError({ statusCode: 404, statusMessage: "No such product", fatal: true });
}

// Computed URL + derived page, the /l/[slug] shape: an in-app navigation between two
// product pages refetches, and the page tracks the response.
const { data, error } = await useFetch<{ page: CatalogPage }>(() => `/api/catalog/page?slug=${slug.value}`);
if (error.value || !data.value?.page) {
  throw createError({ statusCode: 404, statusMessage: "No such product", fatal: true });
}
const page = computed(() => data.value!.page);

const title = computed(() => `${page.value.brand} ${page.value.name}`.trim());
// lightest first: the one order a product's sizes have in common, and the one a
// reader scanning for a number expects (the CSV's own order is alphabetical)
const variants = computed(() => [...page.value.variants].sort((a, b) => a.weightMg - b.weightMg));
const many = computed(() => variants.value.length > 1);
const range = computed(() => pageWeightRange(page.value));

// The figure: grams, promoted to kilograms past one (the social card's threshold).
// Beneath it the same in ounces — pounds only past five, because ounces are how
// makers and hikers write gear this side of a heavy pack ("31.3 oz", not "1.96 lb").
// A range is written in the heavier end's unit so both numbers read on one scale.
const FIVE_LB_MG = 5 * MG_PER_UNIT.lb;
function figure(system: "metric" | "imperial"): { value: string; unit: Unit } {
  const unit = system === "imperial" ? (range.value.maxMg >= FIVE_LB_MG ? "lb" : "oz") : autoUnit(range.value.maxMg, "metric");
  const hi = formatWeight(range.value.maxMg, unit, { withUnit: false });
  if (range.value.minMg === range.value.maxMg) return { value: hi, unit };
  const lo = formatWeight(range.value.minMg, unit, { withUnit: false });
  return { value: lo === hi ? hi : `${lo}–${hi}`, unit };
}
const metric = computed(() => figure("metric"));
const imperial = computed(() => figure("imperial"));

// The citation's voice, by provenance. One label for the page: the makers' own
// figure is the common case; a measured or community weight says so instead.
const sources = computed(() => new Set(variants.value.map((v) => v.weightSource)));
const label = computed(() => {
  if (sources.value.size === 1 && sources.value.has("manufacturer")) return `${page.value.brand || "The maker"} says`;
  if (sources.value.size === 1 && sources.value.has("measured")) return "Weighed on a scale";
  if (sources.value.size === 1 && sources.value.has("community")) return "A community figure";
  return "Cited weights";
});
// http(s) citations only become links — the guard the changes feed and the trail
// link share (shared/trailLink.ts); anything else renders as plain text.
const hostOf = (url: string) => {
  const u = safeUrl(url);
  return u ? { host: displayHost(u), href: u.href } : null;
};
const hosts = computed(() => variants.value.map((v) => hostOf(v.sourceUrl)));
// one attribution for the whole product when every variant cites one host
const sharedHost = computed(() => {
  const first = hosts.value[0];
  return first && hosts.value.every((h) => h && h.host === first.host) ? first : null;
});
const kicker = computed(() => {
  const type = page.value.commonName ?? "";
  return many.value ? `${type} · ${variants.value.length} variants` : type;
});
const gramsUnit = (mg: number) => autoUnit(mg, "metric");

// Head. The description says the number, which is what the query asked; the
// canonical is absolute (useSiteOrigin pins the real origin under the prerender
// crawler). JSON-LD names the product and its weight in grams for anything that
// reads structured data; no offers, no ratings — this is a reference, not a shop.
const origin = useSiteOrigin();
const description = computed(() => {
  const w = `${metric.value.value} ${metric.value.unit}`;
  const kind = page.value.commonName ? `${page.value.commonName.toLowerCase()}, ` : "";
  return many.value
    ? `${title.value}: ${kind}${variants.value.length} variants from ${w}, each weight cited to its source.`
    : `${title.value}: ${kind}${w}, the weight as the maker cites it.`;
});
const jsonLd = computed(() => {
  const grams = (mg: number) => ({ "@type": "QuantitativeValue", value: Math.round(mg / 1000), unitCode: "GRM" });
  const brandNode = page.value.brand ? { brand: { "@type": "Brand", name: page.value.brand } } : {};
  if (!many.value) {
    return { "@context": "https://schema.org", "@type": "Product", name: title.value, ...brandNode, weight: grams(range.value.minMg) };
  }
  return {
    "@context": "https://schema.org",
    "@type": "ProductGroup",
    name: title.value,
    ...brandNode,
    hasVariant: variants.value.map((v) => ({
      "@type": "Product",
      name: v.variant ? `${title.value} (${v.variant})` : title.value,
      weight: grams(v.weightMg),
    })),
  };
});
useHead(() => ({
  title: `${title.value} weight — Mahonia`,
  link: [{ rel: "canonical", href: `${origin}/catalog/${slug.value}` }],
  script: [{ type: "application/ld+json", innerHTML: JSON.stringify(jsonLd.value) }],
}));
useSeoMeta({
  description: () => description.value,
  ogTitle: () => title.value,
  ogDescription: () => description.value,
  ogType: "article",
});
</script>

<template>
  <div>
    <SiteTopbar label="Catalog" />

    <main id="main-content" tabindex="-1" class="wrap page">
      <article class="prod">
        <p v-if="kicker" class="t-sm t-muted prod__kicker">{{ kicker }}</p>
        <h1 class="t-title view__title">{{ title }}</h1>

        <!-- the number the page exists for, in the display role the editor's total
             wears; the unit steps back a shade so the figure is what the eye lands on -->
        <p class="prod__figure t-num">{{ metric.value }}<span class="prod__unit">{{ metric.unit }}</span></p>
        <p class="t-muted t-num prod__alt">{{ imperial.value }} {{ imperial.unit }}</p>

        <!-- a single variant gets the page's one primary action; several get one each,
             on their rows below. nofollow: the editor is a capability, not a page. -->
        <NuxtLink
          v-if="!many"
          class="btn btn--primary prod__pack"
          :to="{ path: '/e', query: { add: page.slug } }"
          rel="nofollow"
          >Pack this</NuxtLink
        >

        <figure class="prod__cite">
          <p class="t-label prod__label">
            {{ label
            }}<template v-if="many && sharedHost"
              >, on
              <a :href="sharedHost.href" class="prod__host" target="_blank" rel="noopener noreferrer"
                >{{ sharedHost.host
                }}<HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" aria-hidden="true" /></a
              ></template
            >
          </p>

          <!-- one variant: the words, set off by a rule, at heading size -->
          <template v-if="!many">
            <blockquote class="prod__quote">{{ displayQuote(variants[0]!.quote) }}</blockquote>
            <figcaption class="t-sm t-muted prod__from">
              <template v-if="hosts[0]"
                >From
                <a :href="hosts[0].href" class="prod__host" target="_blank" rel="noopener noreferrer"
                  >{{ hosts[0].host
                  }}<HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" aria-hidden="true" /></a
                >.</template
              >
              <template v-else>From {{ variants[0]!.sourceUrl }}.</template>
            </figcaption>
          </template>

          <!-- several: one row per variant, its own words beneath it -->
          <ul v-else class="prod__rows">
            <li v-for="(v, i) in variants" :key="i" class="prod__row">
              <span class="prod__variant">{{ v.variant ?? "One weight" }}</span>
              <span class="t-num prod__w"
                >{{ formatWeight(v.weightMg, gramsUnit(v.weightMg), { withUnit: false })
                }}<span class="t-muted prod__wunit">{{ gramsUnit(v.weightMg) }}</span></span
              >
              <NuxtLink
                class="btn btn--link t-sm prod__rowpack"
                :to="{ path: '/e', query: { add: page.slug, variant: v.variant ?? undefined } }"
                rel="nofollow"
                >Pack this</NuxtLink
              >
              <span class="t-sm t-muted prod__rowquote">
                {{ displayQuote(v.quote)
                }}<template v-if="!sharedHost && hosts[i]"
                  >
                  ·
                  <a :href="hosts[i]!.href" class="prod__host" target="_blank" rel="noopener noreferrer"
                    >{{ hosts[i]!.host
                    }}<HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" aria-hidden="true" /></a
                  ></template
                >
              </span>
            </li>
          </ul>
        </figure>
      </article>
    </main>
  </div>
</template>

<style scoped lang="scss">
/* a reading column, like the prose pages: centred in the page's measure */
.prod {
  max-width: var(--prose);
  margin-inline: auto;
}
.prod__kicker {
  margin-bottom: var(--space-2);
}
.prod__figure {
  margin-top: var(--space-6);
  font-size: var(--text-display);
  line-height: 0.95;
  letter-spacing: var(--track-tight);
}
.prod__unit {
  margin-left: 0.15em;
  font-size: var(--text-title);
  letter-spacing: 0;
  color: var(--ink-2);
}
.prod__alt {
  margin-top: var(--space-2);
}
.prod__pack {
  margin-top: var(--space-5);
}
.prod__cite {
  margin-top: var(--space-7);
}
.prod__label {
  margin-bottom: var(--space-3);
}
/* the maker's words, set off by a rule beside them rather than quotation marks */
.prod__quote {
  padding-left: var(--space-4);
  border-left: 2px solid var(--line-2);
  font-size: var(--text-title);
  line-height: var(--leading-tight);
  letter-spacing: var(--track-tight);
  overflow-wrap: anywhere;
}
.prod__from {
  margin-top: var(--space-3);
}
/* an off-site link: full ink under a soft rule, the footer's recipe */
.prod__host {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  color: var(--ink);
  border-bottom: 1px solid var(--line-2);
  transition: border-color var(--dur) var(--ease);
}
.prod__host:hover {
  border-bottom-color: var(--ink-2);
}
.prod__host > svg {
  align-self: center;
}
/* the variant rows: the one place on the page a hairline earns its keep, a dense
   repeating list (the same grid discipline as the changes feed) */
.prod__rows {
  display: flex;
  flex-direction: column;
}
.prod__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: baseline;
  column-gap: var(--space-4);
  row-gap: var(--space-1);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--line);
}
.prod__w {
  text-align: right;
  white-space: nowrap;
}
.prod__wunit {
  display: inline-block;
  width: 2ch;
  margin-left: 0.2em;
  text-align: left;
}
.prod__rowpack {
  font-weight: 600;
}
.prod__rowquote {
  grid-column: 1 / -1;
  overflow-wrap: anywhere;
}

@media (max-width: $bp-stack) {
  .prod__row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .prod__rowpack {
    grid-column: 1 / -1;
    justify-self: start;
  }
}
</style>
