<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowUpRight01Icon, Calendar03Icon, GlobeIcon, RouteIcon } from "@hugeicons/core-free-icons";
import { parseTrailLink } from "~~/shared/trailLink";
import { dayClimbs, parseProfile } from "~~/shared/profile";
import { dayLabel } from "~~/shared/tripDay";
import { formatDistance, resolveDistanceUnit } from "~~/shared/trailDistance";
import type { Item, ListSnapshot, Totals, Unit } from "~~/shared/types";
import { groupItemsByFolder, groupItemsByParent } from "~~/shared/weights";

// The shared body for the two read-only pages (/s/[code] + /l/[slug]). Both render
// the same totals + folder/ungrouped block over the same useReadonlyList view-model
// (kept in the page); only the head, footer, and missing-state copy differ, so those
// are slots. This is purely the shared template + .view CSS — no data shaping
// (beyond the per-folder grouping every ReadonlyFolderSection consumes).
const props = defineProps<{
  list: ListSnapshot | null;
  totals: Totals | null;
  shownFolders: ListSnapshot["folders"];
  ungrouped: ListSnapshot["items"];
}>();

defineEmits<{ "set-unit": [Unit] }>();

// one grouping pass for all folders (ReadonlyFolderSection takes its items pre-grouped),
// each folder ordered by its own sortBy so a shared list reads exactly as the owner's
const itemsByFolder = computed(() => groupItemsByFolder(props.list?.items ?? [], props.list?.folders ?? []));
// one children pass for all rows — a row doesn't re-scan the item array for its children
const childrenByParent = computed(() => groupItemsByParent(props.list?.items ?? []));
const NO_ITEMS: Item[] = [];

// Quiet meta line under the title — the page's read-only status (a #status slot:
// "Read-only" / "Public list") joined with the list's last-edit time into one text
// object. The time is the read-only twin of the editor's SyncStatus suffix: no sync
// words (the viewer isn't writing), just the last server write via the shared
// timeAgo(), so a share link tells the reader how fresh the list is. Ticks silently.
const now = useNow({ interval: 30_000 });
const editedAt = computed(() => {
  const iso = props.list?.updatedAt;
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
});

// The route this list was packed for. Lives here rather than in either page's #head
// slot so /s and /l both get it — /l overrides only the heading block.
const trail = computed(() => parseTrailLink(props.list?.trailUrl, props.list?.trailLabel));
// empty string when the list has no dates, which the v-if reads as absent
const dateLabel = computed(() => formatDateRange(props.list?.startDate, props.list?.endDate));

// ---- the trip, as the owner planned it ----
//
// A planned list that shows only its gear is a list with its plan missing: the itinerary
// was being SERVED on both read paths and rendered on neither, so everyone but the owner
// saw four days of food and no days.
//
// FACTS ONLY. The days carry their distance and their climb, and deliberately not the
// moving time or the calorie figure the editor shows beside them.
//
// The reason has changed shape but not direction. It used to be that those figures were
// computed against the OWNER's body weight, which a shared list never carried. Body
// weight now lives on the reader's own device, so this view could compute them against
// whoever is looking — and still shouldn't, unprompted. A stranger opening a link came to
// see somebody's pack, not to be told what the walk would cost THEM against a number they
// may never have set. The route's shape is a fact about the route; an estimate is a fact
// about a person, and this page is about neither of the two people involved.
// Which half of the list is on screen. The CONTROL is in the sticky header (ReadTopbar,
// via SiteTopbar's #below row) so it stays under the toolbar as you scroll; this file
// only reads the value. See useReadView for why that state is shared rather than passed.
const view = useReadView();
onMounted(resetReadView);

const days = computed(() => props.list?.days ?? []);
const distanceUnit = computed(() =>
  resolveDistanceUnit(props.list?.trailDistanceUnit, props.list?.displayUnit ?? "g"),
);
const profile = computed(() => parseProfile(props.list?.trailProfile));
const dayDistancesM = computed(() => days.value.map((d) => d.distanceM ?? 0));
// the same helper the editor uses, so a shared day reads the climb its owner sees
const climbs = computed(() =>
  dayClimbs(
    profile.value,
    dayDistancesM.value,
    props.list?.trailDistanceM,
    props.list?.trailAscentM,
  ),
);
const climbFor = (i: number) =>
  days.value[i]?.ascentM ?? (days.value[i]?.distanceM != null ? climbs.value[i]?.ascentM : undefined);
const routeM = computed(() =>
  Math.max(props.list?.trailDistanceM ?? 0, dayDistancesM.value.reduce((s, d) => s + d, 0)),
);
// Nothing to show is nothing to draw — a list with no days and no route keeps the shape
// it had before any of this existed.
const hasTrip = computed(() => days.value.length > 0 || profile.value.length > 0);
// feet rounded to the nearest 10, as the editor does: the store is integer metres, so a
// climb quoted to the foot claims a precision the measurement never had
const tripId = useId();
const asHeight = (m: number) =>
  distanceUnit.value === "mi"
    ? `${(Math.round(m / 0.3048 / 10) * 10).toLocaleString()} ft`
    : `${Math.round(m).toLocaleString()} m`;
</script>

<template>
  <main v-if="list && totals" id="main-content" tabindex="-1" class="wrap view">
    <div class="view__header">
      <slot name="head">
        <h1 class="t-title view__title">{{ list.title }}</h1>
      </slot>
      <!-- The byline. Lives here rather than in either page's #head slot so /s and
           /l both get it — /l overrides only the heading block, the same reason the
           trail link sits here. Shown ONLY when the maker set a display name: an
           account is anonymous by default and nothing derives a name from an email.
           Above the edited-at meta line because it's about the list, not its
           freshness. -->
      <p v-if="list.authorName" class="view__byline">by {{ list.authorName }}</p>
      <p v-if="$slots.status || editedAt != null" class="view__meta">
        <span v-if="$slots.status" class="view__status"><slot name="status" /></span>
        <!-- the relative time is a client concern (avoids an SSR/hydration time
             mismatch on the indexable /l page); the dot only shows once it does -->
        <ClientOnly>
          <template v-if="editedAt != null">
            <span v-if="$slots.status" class="view__dot" aria-hidden="true">•</span>
            <span>Edited {{ timeAgo(editedAt, now.getTime()) }}</span>
          </template>
        </ClientOnly>
      </p>
      <!-- nofollow ugc: /l is indexable and this is a viewer-submitted outbound link,
           so without it the public feed reads as a link farm. The favicon is a data:
           URL (fetched server-side, cached per host), so no third-party request leaves
           the viewer's browser and img-src stays 'self' data:. -->
      <a
        v-if="trail"
        class="link view__trail"
        :href="trail.href"
        :title="trail.href"
        target="_blank"
        rel="nofollow ugc noopener noreferrer"
      >
        <!-- every link carries a mark: the site's own once cached, a globe otherwise
             (some hosts block the fetch outright). Same 16px box either way. -->
        <img
          v-if="list.trailFaviconDataUrl"
          class="view__trailicon"
          :src="list.trailFaviconDataUrl"
          alt=""
          width="16"
          height="16"
        />
        <HugeiconsIcon :icon="GlobeIcon" v-else class="view__trailicon view__trailicon--fallback" :size="16" :stroke-width="2" aria-hidden="true" />
        <span class="view__trailname">{{ trail.name }}</span>
      </a>

      <!-- the trip's dates, when it has them. Read-only by nature — there is nothing
           to add here, so unlike the editor there is no affordance, only the fact.
           Formatted by the SAME helper the editor's label uses, so a shared list reads
           the dates identically to the list it was shared from. -->
      <p v-if="dateLabel" class="view__dates">
        <HugeiconsIcon :icon="Calendar03Icon" :size="14" :stroke-width="2" aria-hidden="true" />
        <span>{{ dateLabel }}</span>
      </p>
    </div>

    <TotalsBar :list="list" :totals="totals" @set-unit="(u) => $emit('set-unit', u)" />
    <!-- The trip, between what it weighs and what's in it: the pack's total is the
         list's headline fact, then the walk it was packed for, then the gear itself. -->
    <section v-if="hasTrip && view === 'trip'" class="view__trip" :aria-labelledby="tripId">
      <h2 :id="tripId" class="view__triph">The trip</h2>
      <TrailProfile
        v-if="profile.length && days.length"
        :profile="profile"
        :day-distances-m="dayDistancesM"
        :distance-unit="distanceUnit"
        :total-distance-m="routeM"
        :ascent-m="list.trailAscentM"
        :descent-m="list.trailDescentM"
      />
      <ol v-if="days.length" class="view__days">
        <li v-for="(d, i) in days" :key="d.id" class="view__day">
          <span class="view__dayname">{{ dayLabel(i, list.startDate) }}</span>
          <span v-if="d.distanceM" class="view__dayfig">
            <HugeiconsIcon :icon="RouteIcon" :size="14" :stroke-width="2" aria-hidden="true" />
            {{ formatDistance(d.distanceM, distanceUnit) }}
          </span>
          <!-- `!= null`, not truthiness: a day that genuinely climbs nothing still has a
               climb to report, and hiding it made a flat or downhill day look like a day
               whose data was missing. The editor shows the 0; so does this. -->
          <span v-if="climbFor(i) != null" class="view__dayfig">
            <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
            {{ asHeight(climbFor(i)!) }}
          </span>
        </li>
      </ol>
    </section>

    <div v-if="view === 'gear'" class="view__folders">
      <ReadonlyFolderSection v-for="f in shownFolders" :key="f.id" :list="list" :folder="f" :items="itemsByFolder.get(f.id) ?? NO_ITEMS" :children-by-parent="childrenByParent" />
      <section v-if="ungrouped.length">
        <p class="t-label view__ungrouped">Ungrouped</p>
        <ReadonlyItemRow v-for="it in ungrouped" :key="it.id" :list="list" :item="it" :children-by-parent="childrenByParent" />
      </section>
    </div>
  </main>

  <main v-else id="main-content" tabindex="-1" class="wrap view view--missing">
    <p class="t-muted"><slot name="missing">This list doesn’t exist (or was removed).</slot></p>
    <NuxtLink to="/" class="btn btn--primary">Create a list</NuxtLink>
  </main>
</template>

<style scoped>
.view {
  /* no bottom padding: the site footer's own margin-top is the single content→footer
     gap (matches the inter-folder rhythm), so this row doesn't double it up */
  padding-block: var(--space-5) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
/* the title/head block and its trailing "Edited …" line, kept tight (--space-1) so
   the name + its status/time read as one unit, one --space-6 step off TotalsBar */
.view__header {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* the page-title step, matching the editor's title input — a shared link and the editor
   must render the list's name the same size, or /s reads as a different document */
.view__title {
  font-family: var(--font);
  font-size: var(--text-page-title);
  font-weight: 700;
}
/* status · edited — one quiet line. flex so a #status icon (the /l globe) sits on the
   text baseline, with a drawn middle-dot between the pieces */
/* One step up from the meta line's ink: a name is content, where "edited 3m ago"
   is status. Still quiet enough to sit under the title without competing with it. */
.view__byline {
  margin: 0;
  color: var(--ink-2);
  font-size: var(--text-sm);
}
.view__meta {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-3);
  font-size: var(--text-sm);
}
.view__status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
/* the separator is its own flex child (aria-hidden) so it isn't announced/copied. A
   bullet (•) reads bigger than a middle-dot at the same size; a small negative inline
   margin pulls the status + time a touch closer than the meta's flex gap. */
.view__dot {
  color: var(--ink-3);
  line-height: 1;
  margin-inline: -2px;
}
/* the trail link — one quiet line under the title/meta pair. The mark identifies the
   site and the full destination rides on the anchor's title attribute, so the hostname
   isn't repeated in the text. */
.view__dates {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--ink-3);
  font-size: var(--text-sm);
}
.view__trail {
  display: inline-flex;
  /* baseline so the name sits on the same line as the title/meta above it */
  align-items: baseline;
  /* the mark and the name are one object — --space-2 let the icon drift off the text */
  gap: var(--space-1);
  align-self: flex-start;
  max-width: 100%;
  min-width: 0;
  font-size: var(--text-sm);
}
/* the icon is the one thing that isn't type: baseline-aligning a replaced element sits
   its bottom edge on the baseline, riding visibly high next to the text */
.view__trailicon {
  flex: none;
  align-self: center;
  border-radius: 2px;
}
/* a stand-in, not the site's mark — a step lighter than the link text beside it */
.view__trailicon--fallback {
  color: var(--ink-3);
  opacity: 0.6;
}
.view__trailname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* read views are denser than the editor (no add-item row or controls per folder),
   so the inter-folder gap is a step tighter here (space-6, vs the editor's space-7)
   — the list scans as one block instead of drifting apart. */
/* The trip block. Quiet by construction — it sits between the totals and the gear, and
   the gear is what a reader came for. */
.view__trip {
  margin-top: var(--space-6);
}
.view__triph {
  margin: 0 0 var(--space-2);
  font-size: var(--text-sm);
  font-weight: 600;
  letter-spacing: var(--track-tight);
  color: var(--ink-3);
}
.view__days {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
/* name, then its figures — wraps rather than truncating, because a day with a long
   weekday and two measurements is exactly what a narrow phone gets */
.view__day {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-4);
}
.view__dayname {
  flex: 1 1 auto;
  min-width: 0;
}
.view__dayfig {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.view__folders {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.view__ungrouped {
  margin-bottom: var(--space-1);
}
.view--missing {
  padding-block: var(--space-9);
  align-items: flex-start;
}
</style>
