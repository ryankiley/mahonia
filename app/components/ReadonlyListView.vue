<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ArrowUpRight01Icon, Backpack02Icon, Calendar03Icon, GlobeIcon, Route02Icon, RouteIcon } from "@hugeicons/core-free-icons";
import { parseTrailLink } from "~~/shared/trailLink";
import { dayClimbs, parseProfile } from "~~/shared/profile";
import { dayLabel } from "~~/shared/tripDay";
import { formatDistance, heightStepFor, heightUnitFor, heightValue, resolveDistanceUnit } from "~~/shared/trailDistance";
import { filterItemsForPerson, type PersonSelection } from "~~/shared/people";
import type { Item, ListSnapshot, Person, Totals, Unit } from "~~/shared/types";
import { groupItemsByFolder, groupItemsByParent } from "~~/shared/weights";

// The shared body for the two read-only pages (/s/[code] + /l/[slug]). Both render
// the same totals + folder/ungrouped block over the same useReadonlyList view-model
// (kept in the page); only the head, footer, and missing-state copy differ, so those
// are slots. This is purely the shared template + .view CSS — no data shaping
// (beyond the per-folder grouping every ReadonlyFolderSection consumes; the person
// filter is already applied to `list.items` by the view-model).
const props = defineProps<{
  list: ListSnapshot | null;
  totals: Totals | null;
  shownFolders: ListSnapshot["folders"];
  ungrouped: ListSnapshot["items"];
  // the list's people + the viewer's filter (useReadonlyList) — absent on a
  // peopleless list, and the chips row simply doesn't render
  people?: readonly Person[];
  personFilter?: PersonSelection;
  showUnassigned?: boolean;
  /** each chip's carry, pre-formatted in the viewer's unit (useReadonlyList) */
  chipWeights?: Record<string, string>;
}>();

defineEmits<{ "set-unit": [Unit]; "pick-person": [PersonSelection] }>();

// the empty filter result gets a sentence (see the block below the folders) —
// name resolvable only for a real person; the view-model's widen-watcher keeps
// the Unassigned selection from ever standing empty
const filteredEmptyName = computed(() => {
  if (!props.personFilter) return null;
  if (props.shownFolders.length || props.ungrouped.length) return null;
  return props.people?.find((p) => p.id === props.personFilter)?.name ?? null;
});

// Rows kept on screen ONLY as a label for a matching child: in the visible set the
// view-model hands us, but not in the strict set the totals count. Their own line
// isn't in the figures on this page, so they print no weight — the editor blanks
// the same cell in CSS (atoms/item.scss), which is the only way it can, since no
// row there subscribes to the filter. One Set, threaded down beside childrenByParent.
const contextOnlyIds = computed(() => {
  const items = props.list?.items;
  if (!props.personFilter || !items) return new Set<string>();
  const counted = new Set(filterItemsForPerson(items, props.personFilter).map((i) => i.id));
  return new Set(items.filter((i) => !counted.has(i.id)).map((i) => i.id));
});

// one grouping pass for all folders (ReadonlyFolderSection takes its items pre-grouped),
// each folder in the owner's drag order so a shared list reads exactly as theirs
const itemsByFolder = computed(() => groupItemsByFolder(props.list?.items ?? []));
// one children pass for all rows — a row doesn't re-scan the item array for its children
const childrenByParent = computed(() => groupItemsByParent(props.list?.items ?? []));
const NO_ITEMS: Item[] = [];

// Quiet meta line under the title — the maker's name, the page's status where it has
// one (a #status slot: /l's "Public list"), and the list's last-edit time, as one text
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
// Which half of the list is on screen. Shared state rather than a local ref only because
// it must reset per list — see useReadView.
const view = useReadView();
onMounted(resetReadView);
const VIEW_MODES = [
  { key: "gear", label: "Gear", icon: Backpack02Icon },
  { key: "trip", label: "Trip", icon: Route02Icon },
] as const;

const days = computed(() => props.list?.days ?? []);
const distanceUnit = computed(() => resolveDistanceUnit(props.list?.trailDistanceUnit));
// the route's length, for the trail line up in the header — same helper the editor's
// head row formats with, so a shared list quotes the distance its owner sees
const distanceLabel = computed(() =>
  props.list?.trailDistanceM ? formatDistance(props.list.trailDistanceM, distanceUnit.value) : "",
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
// climb quoted to the foot claims a precision the measurement never had. The conversion,
// the step and the unit word are all shared/trailDistance.ts's, so a shared day reads the
// climb its owner sees.
const tripId = useId();
const asHeight = (m: number) => {
  const unit = distanceUnit.value;
  return `${heightValue(m, unit, heightStepFor(unit))} ${heightUnitFor(unit)}`;
};
</script>

<template>
  <main v-if="list && totals" id="main-content" tabindex="-1" class="wrap view">
    <!-- WHICH VIEW, and only when there is a choice to make. Two modes, not the editor's
         three: packing is impossible here, because a tick is the owner's list data and a
         viewer holds no edit token. A list with no trip keeps exactly the page it had
         before this existed — one mode is not a choice. -->
    <ModeBar
      v-if="hasTrip"
      class="view__modes"
      :modes="VIEW_MODES"
      :current="view"
      label="View"
      @pick="(k) => (view = k as 'gear' | 'trip')"
    />
    <div class="view__header">
      <slot name="head">
        <h1 class="t-title view__title">{{ list.title }}</h1>
      </slot>
      <!-- Who, what, how fresh — one quiet line. The byline leads (shown ONLY when the
           maker set a display name: an account is anonymous by default and nothing
           derives a name from an email), then the page's status (a #status slot, which
           only /l fills — "Public list"), then the last edit. It lives here rather than
           in either page's #head slot so /s and /l both get it — /l overrides only the
           heading block, the same reason the trail link sits here. Dots only ever
           appear BETWEEN two pieces that are present. -->
      <p v-if="list.authorName || $slots.status || editedAt != null" class="view__meta">
        <span v-if="list.authorName" class="view__byline">by {{ list.authorName }}</span>
        <span v-if="list.authorName && $slots.status" class="view__dot" aria-hidden="true">•</span>
        <span v-if="$slots.status" class="view__status"><slot name="status" /></span>
        <!-- the relative time is a client concern (avoids an SSR/hydration time
             mismatch on the indexable /l page); the dot only shows once it does -->
        <ClientOnly>
          <template v-if="editedAt != null">
            <span v-if="list.authorName || $slots.status" class="view__dot" aria-hidden="true">•</span>
            <span>Edited {{ timeAgo(editedAt, now.getTime()) }}</span>
          </template>
        </ClientOnly>
      </p>

      <!-- Where and when: the route the list was packed for, and the trip's dates. One
           line wherever there's room — each is icon-led, so they read as two facts side
           by side without a separator between them. A narrow phone wraps them onto two
           lines rather than squeezing the trail name down to an ellipsis. -->
      <p v-if="trail || dateLabel" class="view__where">
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
          <span class="t-clip view__trailname">{{ trail.name }}</span>
          <!-- How far it goes — the one fact about the route that isn't in its name,
               and the second thing anybody asks after it. The editor's own head row
               carries it (ListHead's .head__dist, same helper, same muted step after
               the name); the share views were dropping it, so a link that read
               "Kearsarge Pass Trail 41.4 mi" to its owner reached everyone they sent
               it to as a bare name. `flex: none` so a long trail name ellipses instead
               of squeezing out four characters that are useless truncated. -->
          <span v-if="distanceLabel" class="view__dist">{{ distanceLabel }}</span>
        </a>

        <!-- the trip's dates, when it has them. Read-only by nature — there is nothing
             to add here, so unlike the editor there is no affordance, only the fact.
             Formatted by the SAME helper the editor's label uses, so a shared list reads
             the dates identically to the list it was shared from. -->
        <span v-if="dateLabel" class="view__dates">
          <HugeiconsIcon :icon="Calendar03Icon" :size="14" :stroke-width="2" aria-hidden="true" />
          <span>{{ dateLabel }}</span>
        </span>
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

    <!-- whose half of the load — the editor's chips, readonly (no manage button).
         SSR'd like the rest of the page (the names are already in the rows below);
         the filter itself is client state that starts, and renders, as Everyone.
         The heading names the block for a first-time viewer — every other block on
         this page has one, and an unlabelled row of names doesn't say it filters. -->
    <section v-if="view === 'gear' && people?.length" class="view__people">
      <p class="t-label view__peopleh">People</p>
      <PeopleBar
        :people="people"
        :selected="personFilter ?? null"
        :show-unassigned="showUnassigned"
        :weights="chipWeights"
        @pick="(id) => $emit('pick-person', id)"
      />
    </section>

    <!-- a filter that matches nothing says so, with the same way back the editor offers -->
    <FilterEmpty v-if="view === 'gear' && filteredEmptyName" :name="filteredEmptyName" @clear="$emit('pick-person', null)" />

    <div v-if="view === 'gear'" class="view__folders">
      <ReadonlyFolderSection v-for="f in shownFolders" :key="f.id" :list="list" :folder="f" :items="itemsByFolder.get(f.id) ?? NO_ITEMS" :children-by-parent="childrenByParent" :context-only-ids="contextOnlyIds" />
      <section v-if="ungrouped.length">
        <p class="t-label view__ungrouped">Unfiled</p>
        <ReadonlyItemRow v-for="it in ungrouped" :key="it.id" :list="list" :item="it" :children-by-parent="childrenByParent" :context-only-ids="contextOnlyIds" />
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
/* the title/head block and the two quiet lines under it (who + status + edited, then
   route + dates), kept tight (--space-1) so the name and everything about it read as
   one unit, one --space-6 step off TotalsBar */
.view__header {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* the h1's page-title step (.view__title) is global — main.scss */
/* by · status · edited — one quiet line. flex so a #status icon (the /l globe) sits on
   the text baseline, with a drawn middle-dot between the pieces, wrapping only once a
   phone runs out of room (a desktop holds all three easily). */
.view__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-3);
  font-size: var(--text-base);
}
/* One step up from the rest of the line's ink: a name is content, where "edited 3m ago"
   is status. Still quiet enough to sit under the title without competing with it. */
.view__byline {
  color: var(--ink-2);
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
/* route + dates on one row. The column gap is wide enough (--space-4, the gap between a
   day and its figures below) that two icon-led facts don't need a dot between them; the
   row gap is the tight one, for when a phone puts the dates on their own line. */
/* BASELINE down this whole line, and the marks step out of it (align-self: center on
   each icon below) — the two-part idiom .head__anchor uses in the editor. Centre
   happened to land these two on the same line while their icons were the same height
   and their text the same size; it was holding by coincidence, and a 16px favicon
   beside a 14px calendar is already two box heights being centred independently.
   Baseline puts the TEXT in charge, which is the thing a reader lines up on. */
.view__where {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-4);
  font-size: var(--text-base);
}
/* the trail link. The mark identifies the site and the full destination rides on the
   anchor's title attribute, so the hostname isn't repeated in the text. It's the piece
   that gives way when the row is tight: shrink (and ellipsis) before the dates do. */
.view__trail {
  display: inline-flex;
  align-items: baseline;
  /* the mark and the name are one object — --space-2 let the icon drift off the text */
  gap: var(--space-1);
  min-width: 0;
}
.view__dates {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
  /* a fact, not a target — never squeezed to make room for a long trail name */
  flex: none;
  color: var(--ink-3);
}
/* the distance rides after the name as a detail OF it, never truncated — ListHead's
   .head__dist, one step quieter than the link it trails */
.view__dist {
  flex: none;
  color: var(--ink-3);
}
/* The mark never gives way — a shrinking row eats the name, never the icon — and it
   steps OUT of the baseline group its box sits in. Both halves matter: an icon centres
   optically on the line rather than perching on the baseline (an <svg>'s own baseline
   is its bottom edge), and an item aligned any other way stops donating its baseline to
   the flex box, which is what leaves the NAME setting the line. Same pair, for the same
   two reasons, as .head__icon in the editor's head row. */
.view__trailicon,
.view__dates > svg {
  flex: none;
  align-self: center;
}
.view__trailicon {
  border-radius: 2px;
}
/* a stand-in, not the site's mark — a step lighter than the link text beside it */
.view__trailicon--fallback {
  color: var(--ink-3);
  opacity: 0.6;
}
/* read views are denser than the editor (no add-item row or controls per folder),
   so the inter-folder gap is a step tighter here (space-6, vs the editor's space-7)
   — the list scans as one block instead of drifting apart. */
/* The trip block. Quiet by construction — it sits between the totals and the gear, and
   the gear is what a reader came for. */
/* Under the toolbar, above the title, scrolling with the page. Matches .editor__modes,
   including leaning on the bar's own padding and the title's leading rather than adding
   a step of its own. */
.view__modes {
  margin-bottom: var(--space-1);
}
.view__trip {
  margin-top: var(--space-6);
}
.view__triph {
  margin: 0 0 var(--space-2);
  font-size: var(--text-base);
  font-weight: 600;
  letter-spacing: var(--track-tight);
  color: var(--ink-3);
}
.view__days {
  margin: var(--space-3) 0 0;
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
/* baseline, with the icon stepping out of it — the day's figures were landing 1px
   above the day NAME they sit beside (.view__day is a baseline row, and a centred
   inline-flex whose first item is an <svg> hands the row a synthesized baseline off
   its own box instead of the number's). Same fix, same two lines, as .view__trail. */
.view__dayfig {
  flex: none;
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.view__dayfig > svg {
  flex: none;
  align-self: center;
}
.view__folders {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}
.view__ungrouped {
  margin-bottom: var(--space-1);
}
/* the people block: heading tight to its chips, the pair one unit in the column */
.view__people {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.view--missing {
  padding-block: var(--space-9);
  align-items: flex-start;
}
</style>
