<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Calendar03Icon, ChevronDownIcon, Copy01Icon, Delete02Icon, Edit02Icon, GlobeIcon, HelpCircleIcon, Location01Icon } from "@hugeicons/core-free-icons";
import {
  distanceFieldValue,
  formatDistance,
  parseDistanceM,
  resolveDistanceUnit,
} from "~~/shared/trailDistance";
import { displayUrl, parseTrailLink, safeUrl } from "~~/shared/trailLink";
// shared/gpx is deliberately absent here AND in useGpxImport, which now owns the
// reading — it is reached through `await import()` inside onGpx, so the file reader
// isn't on the first load of a list nobody imports into. Not even MAX_GPX_BYTES: one
// named import is enough to drag the whole module back onto that path, which is the
// easy way to undo this without noticing.
import type { ListSnapshot } from "~~/shared/types";
import { copyText } from "~/utils/clipboard";

// The editor's title block: the list's name as a page title, with an optional link to
// the route it was packed for.
//
// One row sits under the title holding either "Add a trail" or the link itself, so
// the affordance occupies exactly the slot its result will — adding a link swaps the row
// in place rather than moving it. The affordance rests quiet and darkens on hover — it
// used to hide until hovered, and the note by .head__meta says why that changed. A
// resolved link raises a card with the destination and its actions: on hover where
// there's a pointer that hovers, on a press on the name everywhere (see `pinned`). ONE
// card, one layout, every device. The title lives in here rather than beside it so DOM
// order matches visual order and tab order follows the eye.
const props = withDefaults(
  defineProps<{
    snapshot: ListSnapshot;
    /**
     * Whether the page's big number is already this route's LENGTH.
     *
     * Planning's headline is the distance at display size, so repeating it here as a
     * caption on the trail link is the same fact twice, six inches apart. The other two
     * views headline the pack's WEIGHT, and there the trail's length is the only place it
     * appears at all — so this is hidden by mode rather than deleted.
     */
    distanceIsHeadline?: boolean;
  }>(),
  { distanceIsHeadline: false },
);

const c = useGearList();
// null = at rest. "add" is a single URL box — the one job on the way in. "edit" is the
// full set, reached only by hovering an existing link, so naming it stays a deliberate
// second step rather than a second thing to fill in.
const mode = ref<"add" | "edit" | null>(null);
// Whether the link card is held open. This is what a PRESS on the name does, and it's
// the only way in on a touch device, where there is no hover to reveal it. A fine
// pointer gets hover on top of it, not instead of it — the card is one surface with two
// ways to ask for it, rather than a floating card on the desktop and a second permanent
// in-flow layout on the phone.
const pinned = ref(false);
const open = computed(() => mode.value !== null);
const fieldsId = useId();
const fieldsEl = useTemplateRef<HTMLElement>("fieldsEl");
const trailEl = useTemplateRef<HTMLElement>("trailEl");

const link = computed(() => parseTrailLink(props.snapshot.trailUrl, props.snapshot.trailLabel));
// what the card SHOWS — the destination without the scheme or `www.`, so the
// characters that fit are the ones that say which trail it is. The href is
// untouched; this is only the label. See displayUrl in shared/trailLink.
const cardUrl = computed(() => {
  const u = link.value ? safeUrl(link.value.href) : null;
  return u ? displayUrl(u) : (link.value?.href ?? "");
});

// The title grows to fit its content. `field-sizing: content` (in the stylesheet)
// does this natively; this is the fallback for engines without it, and it runs ONLY
// there — an explicit inline height overrides content sizing, so running both would
// mean the JS silently replacing the free native path with a forced layout flush per
// keystroke. Collapse to auto first, then take scrollHeight: without the reset the
// box can only ever grow, since scrollHeight of an already-tall textarea includes
// the empty space.
const titleEl = useTemplateRef<HTMLTextAreaElement>("titleEl");

// The title is a DRAFT while you're in it — the same shape ItemInput gives a gear
// name, and for the same reason its comment gives: never clobber what the user is
// actively typing.
//
// The field used to bind straight to snapshot.title. That binding is reactive, so
// REPLACING the snapshot re-patches the textarea's value — and the controller
// replaces it out from under you in two places that can't be guarded the way
// flush() and the poll are (`if (!isEditing)`), because both have to install a
// snapshot to have an editor at all: load() adopts the server's copy over the local
// one it painted first, and createFromDraft() adopts the list it just created.
// Neither carries the characters you've typed, because typing isn't an op until it
// commits — so the box was rewritten mid-word and only what you typed AFTERWARDS
// survived to be committed on blur. A three-word name came back as its last word.
//
// Synced from the snapshot only while the field is NOT focused, so a name that
// arrives from elsewhere (a collaborator's rename on the poll, the local copy being
// overtaken by the server's) still updates the heading you aren't touching.
const titleFocused = ref(false);
const draftTitle = ref(props.snapshot.title);
watch(
  () => props.snapshot.title,
  (t) => {
    if (!titleFocused.value) draftTitle.value = t;
  },
);

const needsFit = import.meta.client && !CSS.supports("field-sizing", "content");
function fit() {
  const el = titleEl.value;
  if (!needsFit || !el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
// Follows the DRAFT, which is what the box actually shows: the initial value, and any
// that arrives from OUTSIDE this component — a list loading in, a collaborator's
// rename on a poll — reach it through the sync above. (Typing is covered by @input.)
// Also on resize: the wrap point moves with the column, so a title that fits on one
// line in landscape may need two in portrait.
if (needsFit) {
  watch(draftTitle, () => nextTick(fit), { immediate: true });
  useWindowEvent("resize", fit);
}

// The site's mark. A SAVED list gets it joined into its snapshot server-side; a DRAFT has
// no row yet, so we ask for it directly — the browser can't fetch a third-party icon
// itself under the site's CSP. Kept in a local ref rather than written onto the snapshot:
// it's a cache, not list content, and it must never ride along into an op or a create.
const fetchedIcon = ref<string | null>(null);
// URLs already asked about, so a host that has no usable icon is asked ONCE per page
// life rather than again on every save.
const asked = new Map<string, string | null>();
watch(
  // an ARRAY OF GETTERS, not a getter returning an array: Vue only compares element-wise
  // for the former. A fresh array literal is never Object.is-equal to the last one, so
  // the getter form refired on every autosave — useGearList replaces `snapshot` wholesale
  // on each flush — and re-asked the endpoint every 450ms for any host with no icon.
  [() => props.snapshot.trailUrl, () => props.snapshot.trailFaviconDataUrl],
  async ([url, fromServer]) => {
    if (!url || fromServer) return (fetchedIcon.value = null);
    if (asked.has(url)) return (fetchedIcon.value = asked.get(url) ?? null);
    const res = await $fetch<{ dataUrl: string | null }>("/api/trail-favicon", {
      query: { url },
    }).catch(() => null);
    asked.set(url, res?.dataUrl ?? null);
    // the link may have changed while we were away — don't paint a stale site's mark
    if (props.snapshot.trailUrl === url) fetchedIcon.value = res?.dataUrl ?? null;
  },
  { immediate: true },
);
const icon = computed(() => props.snapshot.trailFaviconDataUrl ?? fetchedIcon.value);

// Everything that describes the route the link pointed AT, cleared. A label with no link
// is unreachable state, and so is a distance, a profile or a line with no route to be the
// shape of. One object because two copies of this list is how the next field added here
// gets cleared on one path and left behind on the other.
const CLEARS_WITH_LINK = {
  trailLabel: "",
  trailDistanceM: "",
  trailProfile: "",
  trailAscentM: "",
  trailDescentM: "",
  routeGeometry: "",
} as const;

// Commits on @change (blur/Enter), the uncontrolled :value pattern the title uses — not
// per keystroke, so a half-typed URL never reaches the reducer (which would reject it).
function commitUrl(e: Event) {
  const value = (e.target as HTMLInputElement).value.trim();
  // one op either way, so clearing the link is one autosave and one undo step
  // (remove() below makes the same single dispatch)
  c.setMeta(value ? { trailUrl: value } : { trailUrl: "", ...CLEARS_WITH_LINK });
}

function commitLabel(e: Event) {
  const el = e.target as HTMLInputElement;
  c.setMeta({ trailLabel: el.value });
  el.value = props.snapshot.trailLabel ?? ""; // resync — see commitTitle
}

// Commits on @change (blur/Enter) and then puts the STORED spelling back in the box,
// because the reducer tidies on the way in and the field has to show what got saved.
// The explicit resync is what covers the case the sync watcher can't: retyping
// "Ryan's Timberline" over a stored "Ryan’s Timberline" tidies to exactly what's
// already in state, so nothing reactive fires and the straight apostrophe would sit
// there looking saved. Assigning the draft rather than el.value, so the field's one
// source of truth stays the ref. Same resync ItemRow's weight and qty fields do.
// autoGrow runs after, because a collapsed run of spaces can shorten the line enough
// to free a row.
function commitTitle(e: Event) {
  const el = e.target as HTMLTextAreaElement;
  c.setMeta({ title: el.value });
  draftTitle.value = props.snapshot.title;
  fit();
}

// Typing moves the DRAFT, not the list — the commit is still @change (blur/Enter),
// as it is for every other text field in the editor. This only keeps the ref level
// with the box, so an arriving snapshot has something current to be held off by.
function onTitleInput(e: Event) {
  draftTitle.value = (e.target as HTMLTextAreaElement).value;
  fit();
}

// ---- the other way in: a GPX ----
// The whole reader — file sniffing, the dialects, the pin offer — is
// useGpxImport. It only ever needed the snapshot and two of the editor's verbs,
// so it lives on its own rather than in the middle of a component that lays out
// a title and some dates. The reasoning about CSP, dedup and route ends went
// with it.
const { gpxError, gpxBusy, pending, confirmPins, onGpx } = useGpxImport(c);

// ---- distance ----
// The route's length, typed. It can't be read off the linked page — see the note atop
// shared/trailDistance.ts — so this is the field that gets it in.

// The owner's pick when they've made one, else miles — see resolveDistanceUnit for why
// the fallback stopped following the weight unit. The picker is for the person whose
// trailhead sign is in kilometres.
const distanceUnit = computed(() => resolveDistanceUnit(props.snapshot.trailDistanceUnit));
// the two as OptionMenu rows: DISTANCE_UNIT_OPTIONS, from app/utils/unitOptions.ts, which
// is where every picker in the app now takes its rows from

// Re-express the SAME stored metres in the newly chosen unit — the stored value never
// moves, only how it reads. (Nothing to convert: the field is derived from metres.)
function pickDistanceUnit(unit: string) {
  c.setMeta({ trailDistanceUnit: unit });
}
// The field shows the bare number; the label beside it carries the unit. Same
// uncontrolled :value + @change shape as the URL and title above.
const distanceValue = computed(() =>
  distanceFieldValue(props.snapshot.trailDistanceM, distanceUnit.value),
);
// What the link row shows at rest, beside the name.
const distanceLabel = computed(() =>
  props.snapshot.trailDistanceM && !props.distanceIsHeadline
    ? formatDistance(props.snapshot.trailDistanceM, distanceUnit.value)
    : null,
);

// A bare "12" means the list's own unit; "7.5 mi" on a metric list still means miles,
// because the parser reads a unit when one is typed. An unparseable value clears,
// which is the reducer's rule for this field too.
function commitDistance(e: Event) {
  const raw = (e.target as HTMLInputElement).value.trim();
  const metres = parseDistanceM(raw, distanceUnit.value);
  c.setMeta({ trailDistanceM: metres ?? "" });
}

function remove() {
  // the distance describes the ROUTE, so it goes with the link rather than outliving it
  c.setMeta({ trailUrl: "", ...CLEARS_WITH_LINK });
  mode.value = null;
}

// Copy the destination — that URL, not the list's own share link (the toolbar handles
// that one). Goes through the shared copyText(), which carries the async-write +
// execCommand fallback iOS Safari needs, and reports via the editor's toast rather than
// a local icon swap, so every copy in the app confirms the same way.
const emit = defineEmits<{ toast: [message: string] }>();
async function copyLink() {
  if (!link.value) return;
  emit("toast", (await copyText(link.value.href)) ? "Trail link copied" : "Copy failed");
}

// ---- trip dates ----
// The second thing in the meta row: two optional calendar dates, and only those. It
// answers "when was this trip" for a list you come back to a year later, which the list
// otherwise cannot say.
// The itinerary those dates now imply is NOT here — planning mode owns the days, the
// waypoints and the estimates (see TrailPlanPanel). This row stays the two ends of the
// range, which is the one fact about a trip that belongs beside its title.
const datesOpen = ref(false);
const datesEl = useTemplateRef<HTMLElement>("datesEl");
const dateLabel = computed(() => formatDateRange(props.snapshot.startDate, props.snapshot.endDate));

// THREE surfaces hang off this one row — the trail panel (`mode`), the trail card
// (`pinned`) and this picker (`datesOpen`) — and they overlap in the same space, so at
// most one may be up. That's two states on the trail side, which is what the rule kept
// missing: `openDates` used to clear `mode` alone, so opening the calendar over a
// pinned card left both on screen, and toggling the card left the calendar up. Closing
// the trail side is therefore one named thing rather than a line each opener has to
// remember; every opener below closes the surfaces it isn't.
function closeTrail() {
  mode.value = null;
  pinned.value = false;
}

// The card is a toggle, so it can't just call an `open` — but it still owes the
// invariant a closed calendar on the way up.
function toggleCard() {
  pinned.value = !pinned.value;
  if (pinned.value) datesOpen.value = false;
}

async function openDates() {
  datesOpen.value = true;
  closeTrail(); // the trail surfaces and this one share the row; never both
  await nextTick();
  // the grid owns one tab stop (roving tabindex), so focus lands on a day
  datesEl.value?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.focus();
}
// One write for both ends. The picker hands back the whole span rather than firing
// per field, so a click that begins a new range clears the old end in the SAME op —
// two separate setMeta calls would leave a moment where the end predates the start.
function commitDates(next: { start?: string; end?: string }) {
  c.setMeta({ startDate: next.start ?? "", endDate: next.end ?? "" });
}
function clearDates() {
  c.setMeta({ startDate: "", endDate: "" });
  datesOpen.value = false;
}
onClickOutside(datesEl, () => (datesOpen.value = false));

async function openFields(next: "add" | "edit") {
  mode.value = next;
  pinned.value = false;
  datesOpen.value = false;
  await nextTick();
  document.getElementById(`${fieldsId}-url`)?.focus();
}

// Close when focus leaves the panel by keyboard. Tabbing between the two inputs (or to
// Remove) keeps it open; tabbing past the last control puts the row back to rest.
function onFocusOut(e: FocusEvent) {
  const nextEl = e.relatedTarget as Node | null;
  // a click on non-focusable chrome gives relatedTarget null — leave that to
  // onClickOutside, which can tell "clicked elsewhere" from "the window lost focus"
  if (nextEl && !fieldsEl.value?.contains(nextEl)) mode.value = null;
}

// …and on a click anywhere outside, the same dismissal GearEditor's ⋯ menu uses.
// focusout alone isn't enough: clicking a bare patch of page focuses nothing, so the
// panel would sit open behind you.
//
// Watched element is the whole ROW, not the panel: the Edit/Add button that opens the
// panel lives in that row, and targeting the panel alone would let the very click that
// opens it register as an outside click and close it again.
onClickOutside(trailEl, closeTrail);
</script>

<template>
  <div class="head">
    <!-- A TEXTAREA, not an input: a list name is a page title and long ones must wrap.
         An <input> is single-line by definition — "Sierra High Route — September 2026" scrolled
         sideways inside its box and you could only ever read the start of it. Rows is 1
         and it grows to fit (see autoGrow); Enter commits rather than inserting a
         newline, so the value stays the single line of text it is. -->
    <!-- The pencil is a HINT, not a mode. The field stays live — you can click the
         text and type, exactly as before — but nothing on screen said so, and a
         borderless title reads as a heading. Revealed on hover in a slot that is
         always reserved, so nothing reflows when it appears. aria-hidden with no tab
         stop: a <textarea> already announces itself as editable, so the icon is
         decoration for the eye only. -->
    <div class="head__titlewrap">
      <textarea
        ref="titleEl"
        class="field head__title"
        rows="1"
        :value="draftTitle"
        placeholder="List name"
        aria-label="List name"
        autocorrect="off"
        spellcheck="false"
        @focus="titleFocused = true"
        @blur="titleFocused = false"
        @input="onTitleInput"
        @keydown.enter.prevent="($event.target as HTMLTextAreaElement).blur()"
        @change="commitTitle"
      />
      <HugeiconsIcon
        :icon="Edit02Icon"
        class="head__pencil"
        :size="16"
        :stroke-width="2"
        aria-hidden="true"
      />
    </div>

    <!-- One row under the title, holding either the affordance or its result — the
         "Add a trail" button occupies exactly the slot the link will, so adding one
         swaps the contents in place instead of moving the row across the title. The
         edit panel anchors to this row, so the link stays visible above it. -->
    <p ref="trailEl" class="head__trail">
      <!-- The affordance and the link it produces share this slot, which is the whole
           point of the row. `out-in` so the two never overlap on a one-line row: the
           old leaves, the new arrives on the beat, and the row's min-height holds the
           line through the gap so nothing reflows.
           Its own name, not `menu`: this is an IN-FLOW content swap, not a surface
           hanging off a control — but it spends the same --dur/--ease as everything
           else, so it reads as the same interface moving. See the motion note in
           atoms/controls.scss. -->
      <Transition name="trailswap" mode="out-in">
      <button
        v-if="!link"
        type="button"
        class="btn btn--quiet head__add"
        :aria-expanded="open"
        :aria-controls="fieldsId"
        @click="openFields('add')"
      >
        <!-- 14 = the small icon tier, the size every other inline-with-text icon uses.
             Same glyph the link's own fallback mark uses, so the affordance and what it
             produces read as one thing. -->
        <!-- a PIN, not the globe: this affordance is about the place you're going.
             The two globes below are different — they're the fallback mark for a site
             with no favicon, standing in for "a website", which a pin would misstate. -->
        <HugeiconsIcon :icon="Location01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
        Add a trail
      </button>

      <!-- the resolved link: the site's mark + the trail's name. No hostname — the mark
           identifies the site, an opaque URL falls back to showing the hostname AS the
           name, and the card below carries the destination in full. -->
      <span v-else class="head__anchor">
        <!-- A BUTTON, not a link: in the editor this opens the card rather than
             navigating. Tapping the name used to leave the page, which on a phone (no
             hover) meant Edit and Remove were unreachable — you'd have to come back to
             get at them. The destination is still one tap away, on the URL inside the
             card. The read views keep a real anchor: there's nothing to edit there, so
             clicking the name should go where it says. -->
        <button
          type="button"
          class="link head__link"
          :aria-expanded="pinned"
          @click="toggleCard"
        >
          <!-- every link carries a mark. The site's own once we've cached it; a globe
               until then — some hosts block the fetch outright. Same 16px box either
               way, so nothing shifts when the real icon arrives. -->
          <img
            v-if="icon"
            class="head__icon"
            :src="icon"
            alt=""
            width="16"
            height="16"
          />
          <HugeiconsIcon :icon="GlobeIcon" v-else class="head__icon head__icon--fallback" :size="16" :stroke-width="2" aria-hidden="true" />
          <span class="head__name">{{ link.name }}</span>
          <!-- The one fact about the route that isn't in its name. Muted and after the
               name, so it reads as a detail OF the trail rather than a second link;
               absent entirely until it's set, like every other optional field here. -->
          <span v-if="distanceLabel" class="head__dist">{{ distanceLabel }}</span>
        </button>

        <!-- The link card: the destination in full, then the actions on it. Asked
             for — by hover, by a press on the name, or by keyboard focus — rather than
             sitting in the layout, because the link is the content and Edit/Remove are
             only ever wanted deliberately. The press is what carries a phone, which has
             no hover; it means one card at every pointer instead of two layouts. -->
        <span v-if="!open" class="head__card popover" :class="{ 'is-pinned': pinned }">
          <img
            v-if="icon"
            class="head__cardicon"
            :src="icon"
            alt=""
            width="14"
            height="14"
          />
          <HugeiconsIcon :icon="GlobeIcon" v-else class="head__cardicon head__icon--fallback" :size="14" :stroke-width="2" aria-hidden="true" />
          <a
            class="head__cardurl"
            :href="link.href"
            target="_blank"
            rel="nofollow ugc noopener noreferrer"
          >{{ cardUrl }}</a>
          <button
            type="button"
            class="btn btn--quiet head__cardbtn"
            aria-label="Copy link"
            @click="copyLink"
          >
            <!-- 14, tracking the card's own type: a glyph sits at the size of the text
                 beside it, 1:1. 16 is the size for marks beside 16px text (the link row)
                 and reads oversized in here. The stroke drops below the house's 2 as
                 well — at 14 a 2-weight outline carries more ink than the words it sits
                 among, so it stops reading as their equal. 1.75 and not 1.5: the lighter
                 stroke went spindly, and this is the smallest step back that matches. -->
            <HugeiconsIcon :icon="Copy01Icon" :size="14" :stroke-width="1.75" aria-hidden="true" />
          </button>
          <!-- no Remove here: removal lives one level in, behind Edit (the fields row
               below carries it). Keeping a destructive action out of a surface that
               appears on hover is also just safer. -->
          <!-- 6px gaps between the mark, the URL and the copy glyph, then 12px before
               "Edit" — the icon belongs to the URL it acts on, so it sits with it; the
               word is a separate control and takes the wider gap. -->
          <button
            type="button"
            class="btn btn--quiet head__cardbtn head__cardedit"
            :aria-expanded="open"
            :aria-controls="fieldsId"
            @click="openFields('edit')"
          >
            Edit
          </button>
        </span>
      </span>
      </Transition>

      <!-- DATES. Same shape as the trail affordance beside it: the button occupies the
           slot its result will, so setting a date swaps the contents in place rather
           than growing the row. -->
      <span ref="datesEl" class="head__dates">
        <button
          type="button"
          class="btn btn--quiet head__add head__datesbtn"
          :aria-expanded="datesOpen"
          @click="datesOpen ? (datesOpen = false) : openDates()"
        >
          <HugeiconsIcon :icon="Calendar03Icon" :size="14" :stroke-width="2" aria-hidden="true" />
          {{ dateLabel || "Add dates" }}
        </button>
        <Transition name="menu">
          <span v-if="datesOpen" class="popover head__datespanel" role="dialog" aria-label="Trip dates">
            <!-- Lazy: ListHead is on the editor's first load, but a month grid is
                 only ever seen by someone who opened this popover. It's already
                 behind the v-if, so deferring the CHUNK too costs nothing — the
                 fetch starts on the same click that reveals it. -->
            <LazyDateRangePicker
              :start="snapshot.startDate"
              :end="snapshot.endDate"
              @update="commitDates"
            />
            <!-- No summary line here. The range is already said twice over: the grid
                 fills its two ends and tints between them, and the affordance this
                 popover hangs off has swapped its label to the range. A third copy
                 inside the panel restated what you were looking at. -->
            <button v-if="dateLabel" type="button" class="btn btn--quiet head__dateclear" @click="clearDates">
              Clear
            </button>
          </span>
        </Transition>
      </span>


      <!-- The edit panel, anchored under the row so the link stays visible above it.
           No "Done": the inputs commit on change (blur/Enter) like every
           other field in the editor, so a confirm button would only be confirming
           something already saved. Focus leaving the panel closes it. -->
      <span
        v-if="open"
        :id="fieldsId"
        ref="fieldsEl"
        class="head__panel popover"
        @focusout="onFocusOut"
        @keyup.escape="mode = null"
      >
        <!-- TWO ways in now, which is why the affordance above says "Add a trail" rather
             than naming either of them. A LINK is the common one, so it stays first and
             unadorned. A GPX is the richer one — it carries the distance and the shape of
             the climb, which no link can — but it asks you to find a file, so it sits
             second and says what it gives you rather than what it is.
             The field itself is still a URL and nothing else: type="url", https://
             placeholder. "Link", not "Page or URL", which offered a choice that isn't
             there. -->
        <label class="head__panellabel" :for="`${fieldsId}-url`">Link</label>
        <input
          :id="`${fieldsId}-url`"
          class="head__panelinput"
          type="url"
          inputmode="url"
          placeholder="https://"
          autocorrect="off"
          spellcheck="false"
          :value="snapshot.trailUrl ?? ''"
          @change="commitUrl"
          @keyup.enter="mode = null"
        />

        <p class="head__gpx t-sm">
          <label class="head__gpxbtn">
            <input type="file" accept=".gpx,.kml,.kmz,.tcx,.geojson,.json,.xml,application/gpx+xml,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/geo+json,application/json,text/xml" @change="onGpx" />
            {{ gpxBusy ? "Reading…" : snapshot.trailProfile ? "Replace map file" : "Import map file" }}
          </label>
          <Tooltip
            text="GPX, KML, KMZ, TCX, GeoJSON or GeoRSS. Reads the route's distance and the shape of its climb — the file is read here in your browser and never uploaded."
            preferred-placement="bottom"
          >
            <button type="button" class="head__gpxwhy" aria-label="Which map files can be read">
              <HugeiconsIcon :icon="HelpCircleIcon" :size="14" :stroke-width="2" aria-hidden="true" />
            </button>
          </Tooltip>
        </p>
        <p v-if="gpxError" class="head__gpxerr t-sm">{{ gpxError }}</p>
        <!-- An OFFER, not an import. The route is already in by the time this appears —
             this is only the pins the file also carried, and they wait because a file can
             hold thousands and undoing them would be one tap each. Phrased with the count
             so the answer is informed: "add 11" is a different question from "add 400". -->
        <p v-if="pending" class="head__gpxerr t-sm">
          That file also has {{ pending.pins.length }}
          {{ pending.pins.length === 1 ? "marked place" : "marked places" }}.
          <button type="button" class="head__gpxyes" @click="confirmPins">Add them</button>
          <button type="button" class="head__gpxno" @click="pending = null">No thanks</button>
        </p>

        <!-- edit only. On the way IN the single job is pasting a URL; a title box there
             reads as a second thing to fill in, when most links name themselves from the
             URL anyway. It's here for the ones that can't (caltopo.com/m/ABC). -->
        <template v-if="mode === 'edit'">
          <label class="head__panellabel" :for="`${fieldsId}-title`">Link title</label>
          <input
            :id="`${fieldsId}-title`"
            class="head__panelinput"
            :placeholder="link?.name ?? ''"
            :value="snapshot.trailLabel ?? ''"
            @change="commitLabel"
            @keyup.enter="mode = null"
          />

          <!-- Typed, because it cannot be fetched: the linked page answers a
               server-side GET with 403 and there's no API to ask instead. Anyone
               pasting a trail link is looking at the number on that page.
               A bare number is read in the unit the picker beside it shows; typing
               "7.5 mi" into a list set to km still works, because the parser reads a
               unit off the value and prefers it to the picker's. -->
          <!-- "optional" rides in the LABEL, not the placeholder: a placeholder is gone
               the moment you type, which is exactly when you'd want to know you could
               have left it empty. The other two fields are optional too, but this is
               the one that reads as a thing the app needs — it's the only number in
               here, and a number in a form looks required. -->
          <label class="head__panellabel" :for="`${fieldsId}-dist`">Distance (optional)</label>
          <!-- The unit sits INSIDE the field's row rather than in the label, because
               it's a control and the label isn't. Same chevron-beside-an-abbreviation
               the totals bar and each item row use — one vocabulary for one gesture. -->
          <span class="head__distrow">
            <input
              :id="`${fieldsId}-dist`"
              class="head__panelinput head__distinput"
              inputmode="decimal"
              autocorrect="off"
              spellcheck="false"
              :placeholder="distanceUnit === 'mi' ? '7.5' : '12'"
              :value="distanceValue"
              @change="commitDistance"
              @keyup.enter="mode = null"
            />
            <OptionMenu
              class="head__distunit"
              :options="DISTANCE_UNIT_OPTIONS"
              :current="distanceUnit"
              label="Distance unit"
              title="Change distance unit"
              @pick="pickDistanceUnit"
            >
              <template #trigger="{ open }">
                <span class="t-sm t-muted">{{ distanceUnit }}</span>
                <!-- 12/2 = an exact 1px stroke, the small-size counterpart to the
                     total's 16/2.25 — matching ItemRow's per-row unit chevron. -->
                <HugeiconsIcon
                  :icon="ChevronDownIcon"
                  class="head__distchev"
                  :class="{ 'is-open': open }"
                  :size="12"
                  :stroke-width="2"
                  aria-hidden="true"
                />
              </template>
            </OptionMenu>
          </span>
          <hr class="head__paneldiv" />
          <button type="button" class="menu__item head__panelremove" @click="remove">
            <HugeiconsIcon :icon="Delete02Icon" :size="16" :stroke-width="1.5" aria-hidden="true" />
            Remove link
          </button>
        </template>
      </span>
    </p>
  </div>
</template>

<!-- lang="scss" for $bp-stack (injected into every scss block by nuxt.config's
     additionalData). This block was plain CSS, where `@media (max-width: $bp-stack)`
     is not a parse error you get told about — the browser simply drops the whole rule
     and the mobile fix below silently does nothing. Every other media query here is a
     capability query (hover/pointer), which is why it had never come up. -->
<style scoped lang="scss">
.head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* The title and its hint share a row; the icon sits after the text rather than over
   it, so it can never cover a character of a long name.
   CENTERED on the first line, not on the whole box: a title that wraps to two lines
   would otherwise drag the hint to the middle of the block, away from the words it
   belongs to. `align-items: baseline` can't do it either — the textarea's baseline is
   its LAST line. So the hint is centred against one line's height, set below. */
.head__titlewrap {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}
/* Reserved at rest rather than appearing: the box stays in layout, so revealing the
   hint moves nothing. Opacity is what fades; visibility rides along in the same
   transition so it flips at the END of the fade-out and the START of the fade-in
   (that's how visibility interpolates), keeping the hidden hint out of the a11y tree
   without snapping it on or off. */
.head__pencil {
  flex: none;
  /* Centred on the title's CAP HEIGHT, not its line box.
     Centring on the line box put this 4.4px high, because a title's ink sits low in
     its box: the face's ascent is 0.969em but its caps are only 0.705em, and the
     leading is split evenly above and below. So the optical centre of the word is
     well under the box's middle.
     Cap height, not the rendered glyphs — measuring actual ink would move the hint
     the moment you typed a "y".
     From the wrapper's top:  .field's padding-top
                            + half-leading (1.2 - 0.969 - 0.219) / 2 = 0.006em
                            + ascent 0.969em
                            - half the cap height 0.352em      = 0.62em to the centre
                            - half the 16px glyph
     em can't be used directly (it would resolve against this SVG's inherited 16px,
     not the title's 32px), so the title's own token is multiplied explicitly. */
  margin-top: calc(var(--space-1) + 0.62 * var(--text-page-title) - 8px);
  color: var(--ink-3);
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--dur) var(--ease),
    visibility var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.head__titlewrap:hover .head__pencil,
.head__titlewrap:focus-within .head__pencil {
  opacity: 1;
  visibility: visible;
}
.head__titlewrap:focus-within .head__pencil {
  color: var(--ink-2);
}
/* a coarse pointer has no hover to reveal it with, and a permanently-visible hint
   next to every title is clutter — so on touch the field simply stays as it was */
@media (hover: none) {
  .head__pencil {
    display: none;
  }
}
/* width:100% is the FALLBACK. Where field-sizing works the box shrinks to its text
   (see the rule at the end of this block), which is what puts the hover pencil beside
   the title instead of stranded at the far edge of the column. */
.head__title {
  width: 100%;
  font-family: var(--font);
  /* the page-title step — a document title, not a section heading. Well above the 16px
     threshold that triggers iOS Safari's focus-zoom, so .field's literal-1rem
     workaround (controls.scss) doesn't apply here. */
  font-size: var(--text-page-title);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: var(--track-tight);
  /* textarea defaults that have to go for it to read as a title rather than a control:
     no drag handle, no scrollbar (it's sized to its content, so there's nothing to
     scroll), and no min-height from .field — one line at this size is already taller
     than --field-h, and the floor would add dead space under a single-line name. */
  resize: none;
  overflow: hidden;
  min-height: 0;
  /* the primary mechanism: the box sizes to its content, wrapped lines and all. fit()
     in the script is the fallback for engines without it, and is inert where this
     works — see the note there for why only one of the two may ever be live. */
  field-sizing: content;
}
/* Only where the engine actually sizes to content — otherwise width:auto on a plain
   textarea collapses it to its `cols` default (~20 characters). Guarded by @supports
   for the same reason the script's fit() is guarded by CSS.supports. */
@supports (field-sizing: content) {
  .head__title {
    width: auto;
    max-width: 100%;
  }
}
/* much lighter than .field's --ink-3 default: at 32px bold, --ink-3 reads as a real
   title someone typed rather than as an empty field. See --ink-ghost in tokens.scss
   for why going under the AA floor is sound here specifically. */
.head__title::placeholder {
  color: var(--ink-ghost);
}
/* the trail link row — baseline-aligned with the type around it. Holds the "Add trail
   link" button OR the resolved link, in the same place, and keeps its height either way
   so nothing below shifts as the affordance fades in or a link is added. */
.head__trail {
  position: relative; /* anchors the edit panel */
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  /* Two gaps, because the two axes are answering different questions.
     ACROSS: --space-4, not --space-2. This row used to hold ONE affordance, where a
     tight gap only had to separate an icon from its label. It now holds two
     independent ones (trail, dates) and at 8px they read as a single run-on phrase.
     DOWN: --space-1, the step the title already sits above this row by. The row wraps,
     so on a phone the dates take a line of their own — and a single `gap` spent the
     across-value there too, dropping the dates 16px under a link that is itself 4px
     under the title. Same two facts about the trip, one stacked four times further
     from it than the other. A wrap is a line break in one stack of meta, not a gap
     between two things standing side by side. */
  gap: var(--space-1) var(--space-4);
  min-width: 0;
  min-height: 1.5em;
}
.head__link {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  /* it's a <button> (see the template note), so the UA's chrome has to go — it should
     read as the line of text it looks like, not as a control */
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  letter-spacing: inherit;
  text-align: start;
  cursor: pointer;
}
/* the icon is the one thing that ISN'T type: baseline-aligning a replaced element sits
   its bottom edge on the baseline, which rides visibly high next to the text */
.head__icon {
  flex: none;
  align-self: center;
  border-radius: 2px;
}
/* the globe stands in for a real mark, so it should read as a placeholder rather than
   as the site's own icon — a step lighter than the link text it sits beside */
.head__icon--fallback {
  color: var(--ink-3);
  opacity: 0.6;
}
.head__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The distance rides after the name as a detail of it. `flex: none` so a long trail
   name ellipses (the rule above) instead of squeezing the number out — the name is
   the thing you can afford to lose characters from, since the card carries the URL
   in full and this is four characters that are useless truncated. */
.head__dist {
  flex: none;
  color: var(--ink-3);
}
.head__anchor {
  /* deliberately NOT a positioning context: the floating card below is absolute, and
     anchoring it here made .head__anchor its containing block — so `max-width: 100%`
     resolved to the width of the NAME. It anchors to .head__trail instead (already
     relative, for the edit panel), whose box is the page column, which is the bound
     the card actually wants. Same left edge either way: the anchor is the row's first
     item, so inset-inline-start: 0 lands in the same place. */
  display: inline-flex;
  align-items: baseline;
  min-width: 0;
  /* content-sized (flex's initial 0 1 auto): the card floats out of flow at every
     pointer, so the anchor is only ever as wide as the name it holds and never claims
     the whole row */
}
/* The link card: the destination in full, then the actions on it. It FLOATS
   under the link at every pointer type, and it is hidden until asked for. What asks for
   it differs by pointer, and only that: a hover where there is one, a press on the name
   where there isn't (`pinned`, in the script — a press works on a fine pointer too).
   It used to sit permanently in the flow on a coarse pointer, on the reasoning that a
   phone has no hover to reveal it — but that put a URL, a copy button and Edit under
   every title on every phone, permanently, to serve a panel you open rarely. A press
   reveals it, which is the gesture a touch device has, and the phone gets the same
   surface the desktop does rather than a second layout to keep in step. */
.head__card {
  position: absolute;
  top: 100%;
  inset-inline-start: 0;
  /* menu layer, not --z-float: this is a popover of actions, and it should sit under
     the toast/dialog surfaces rather than competing with them */
  z-index: var(--z-menu);
  display: inline-flex;
  align-items: center;
  /* wider than the icon-to-its-own-text step: the glyph belongs to the URL it acts on,
     "Edit" is a separate control */
  gap: var(--space-2);
  min-width: 0;
  /* out of flow, so it sizes to its CONTENT, bounded by `max-width: 100%` — which is
     the page column, since .head__trail is the containing block. Content-sized but
     never past the screen edge. The URL inside carries the shrinking (see below). */
  flex: 0 0 auto;
  width: max-content;
  max-width: 100%;
  /* --radius-3 is the small-card step; inner surfaces derive from it with calc() so a
     nested curve can never end up rounder than the box holding it. */
  padding: var(--space-2) var(--space-3);
  /* --radius-3 stays: this card is ~32px tall, and --radius-4 on that is the lozenge
     the token's own note warns about. The SHADOW no longer diverges — the local ring
     and tight drop were there because --shadow-soft had a 48px spread that read mushy
     at this size, and it hasn't since the token became one value for every surface. */
  border-radius: var(--radius-3);
  /* the item radius still repins, because the corner still differs from the atom's */
  --popover-item-radius: calc(var(--radius-3) - var(--space-1));
  font-size: var(--text-chrome);
  /* tight leading, not the inherited 1.5 — the card's height is content + padding, and
     1.5 alone pushed it past the 32px that squares it with the row's icon buttons */
  line-height: 1.2;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--dur) var(--ease),
    visibility var(--dur) var(--ease);
}
/* A press on the name pins it open, and keyboard focus reveals it — both at every
   pointer type, so a phone and a tabbing user can reach Edit and Remove. Hover is the
   fine-pointer addition, further down. */
.head__anchor:focus-within .head__card,
.head__card.is-pinned {
  opacity: 1;
  visibility: visible;
}
/* muted, not full ink — the URL is what you're confirming, not what you act on, so the
   ACTION beside it takes the emphasis. (Darkening it was a guess; it wants to be the
   other way round.) */
/* block, not the browser's default inline: an inline <img> sits on the text baseline and
   reserves descender space under it, which was making the card 34px rather than the 32
   that squares it with the icon buttons in the row above (--icon-btn) */
.head__cardicon {
  flex: none;
  display: block;
  border-radius: 2px;
}
/* The URL FLEXES between a floor and a ceiling rather than being sized by its content.
   Content-sizing gave the two bad ends: a 45-character URL made the card wider than the
   phone, and clamping the card to its parent squeezed the URL to "all…". Between 12ch
   and 32ch it takes what the row can spare — the whole line on a phone, a comfortable
   measure on a desktop — and ellipsises at either end. 12ch is the floor because below
   that the text stops identifying anything; with the card's chrome it still fits the
   narrowest phone — the card floats there too, so this is the rule that keeps it inside
   a 320px screen rather than a second, in-flow layout. */
.head__cardurl {
  flex: 1 1 auto;
  min-width: 12ch;
  max-width: 32ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* the one thing here that navigates, so it deepens on hover — quiet at rest, because
     the card is a place you land on the way to Edit as often as to the trail itself */
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.head__cardurl:hover,
.head__cardurl:focus-visible {
  color: var(--ink);
}
/* the actions are the emphasis in this card: full ink, regular weight. The explicit
   font-size is load-bearing — .btn hard-sets --text-base (16px), which would otherwise
   leave "Edit" at 16px beside a 12px URL and push the card to 40px tall against the
   reference's 32px. */
.head__cardbtn {
  flex: none;
  color: var(--ink);
  font-size: var(--text-chrome);
  font-weight: 400;
}
/* opens the row's 8px gap out to 12 before the word (see the template note) */
.head__cardedit {
  margin-inline-start: var(--space-1);
}
/* .btn's own --space-2 reads loose once the glyph is only 14px. No padding or background:
   the affordance is a line of text in the page's own flow, not a control on a surface, so
   colour alone carries the hover — and with no box, its glyph sits flush at the same x as
   the resolved link's mark with nothing to compensate for. */
.head__add {
  gap: var(--space-1);
  color: var(--ink-3);
  /* BOTH properties in one declaration, including the opacity the media query below
     animates. `transition` is a shorthand: a second declaration replaces the whole list
     rather than adding to it, so a `transition: opacity …` down there would silently drop
     the colour ease and the hover would snap. */
  transition:
    opacity var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
/* Explicit, and load-bearing: .btn--quiet:hover already sets --ink, but scoping adds a
   [data-v-] attribute to the rule above, tying its specificity with that hover rule —
   and component styles are ordered after the atoms, so the resting colour was winning
   even while hovered and the button never responded to the pointer at all. The icon
   inherits currentColor, so it lifts with the text. */
.head__add:hover,
.head__add:focus-visible {
  color: var(--ink);
}
/* Hover-capable pointers only. On touch there IS no hover, so these stay painted —
   hiding them would leave phone users with no way to reach the field at all. Opacity,
   not display, so nothing reflows as the affordance comes and goes. */
@media (hover: hover) and (pointer: fine) {
  /* Hover is this pointer's EXTRA way in — the card itself, and the press that pins it,
     are the base rules above. top:100% with no gap keeps the card's box FLUSH to the
     link's, so travelling down into it never crosses dead space and dismisses the thing
     you were reaching for; the card's own padding supplies the visual offset. */
  .head__anchor:hover .head__card {
    opacity: 1;
    visibility: visible;
  }
}
/* The edit panel — a floating form anchored under the link, so the link stays visible
   above it while you change where it points. */
.head__panel {
  position: absolute;
  top: calc(100% + var(--space-1));
  inset-inline-start: 0;
  z-index: var(--z-menu);
  display: flex;
  flex-direction: column;
  /* no flex gap — every gap here is set explicitly below, because the rhythm ISN'T
     uniform: a label belongs to the field under it, so those two sit tight while the
     gap between one field and the next label opens up to separate the pairs */
  gap: 0;
  /* 330px: wide enough that an ordinary URL reads without wrapping, narrow enough that
     the panel still sits over the row as a popover rather than becoming a column */
  width: min(20.625rem, 100%);
  /* Uniform. The Remove row pulls ITSELF into this padding (below) rather than the panel
     thinning its floor — in "add" mode there is no Remove row, and a thinned floor left
     the lone URL field crammed against the bottom edge with a full step above it. */
  padding: var(--space-3);
  /* The atom's corner and shadow, unmodified. This used to take --radius-3 and a local
     ring-plus-drop, on the reasoning that --shadow-soft was "built for big anchored
     menus" with a 48px spread. That stopped being true when the token was rewritten to
     one value for every size — it is a 28px layer now — so the override was carrying a
     divergence for a reason that no longer existed, and this panel sat visibly apart
     from the date picker beside it, which is the same kind of surface at the same size.
     Dropping the corner override also retires the --popover-item-radius repin that
     existed only to keep rows from curving more than the box holding them. */
  border-radius: var(--radius-4);
  text-align: start;
}
/* 12px + medium weight — the smaller of the two chrome steps, so the labels stay
   subordinate to the fields and row beneath them. A label
   belongs to the field UNDER it, so it sits closer to that field (8) than the field above
   sits to it (16, set on the adjacent-sibling rule below). */
.head__panellabel {
  margin-block-end: var(--space-2);
  color: var(--ink-3);
  font-size: var(--text-micro);
  font-weight: 600; /* the type system's one strong weight — no 500 (typography.scss) */
  line-height: 1.2; /* 14.4px — a tight box, so the label reads as attached to its field */
}
/* filled, unlike the borderless .field used everywhere else: inside a floating panel
   there's no surrounding structure to imply where the input begins, so the fill IS the
   boundary. Each label sits above its own field, so a placeholder never has to stand in
   for one. */
.head__panelinput {
  width: 100%;
  /* 2em — a field twice the height of its own type, which is the proportion a compact
     field wants. --field-h (36px) came out visibly taller because this input is locked to 16px (see
     below); expressing it as a ratio keeps the proportion instead of the pixel. */
  min-height: 2em;
  /* the inherited 1.5 leading (24px here) plus padding and border already exceeds 2em,
     so min-height never bound and the field came out 34px. Tightening the leading lets
     the ratio above actually govern the height. */
  line-height: 1.25;
  padding: var(--space-1) var(--space-2);
  /* No outline, at rest or focused (the reset already gives inputs none — the old
     `1px solid transparent` was opting back IN so a focus ring could ink it). The
     fill IS the field here; a ring on top said the same thing twice, and the site's
     own inputs carry no border at all — the caret carries focus. */
  /* smaller than the panel's own corner — derived, so it tracks --radius-3 */
  border-radius: calc(var(--radius-3) - var(--space-1));
  background: var(--paper-2);
  color: var(--ink);
  /* stays at 16px while the labels above drop to 12px: 14 would sit better with them,
     but anything under 16px makes iOS Safari zoom the page on focus (atoms/controls.scss) */
  font-size: 1rem;
  font-family: inherit;
}
.head__panelinput:focus {
  outline: none;
}
/* a label after a field gets a step of air — whichever thing the field is here: the
   bare input, the distance row that wraps its own, or the file row that sits between
   the URL and the title's label. If a fourth kind lands here, this wants to become a
   rule about the panel's children rather than a longer list. */
:is(.head__panelinput, .head__distrow, .head__gpx) + .head__panellabel {
  margin-block-start: var(--space-4);
}
/* Number and unit on one line, the unit taking only what it needs. NOT absolutely
   positioned inside the field: OptionMenu's button is behind a component boundary, so
   a scoped rule here can't reach it (its own comment says why) — and it already
   carries the button reset this needs. Only the ROOT takes this file's scoped
   attribute, which is why .head__distunit is the only hook, and the chevron is styled
   freely because it's slot content and therefore mine. */
.head__distrow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.head__distinput {
  flex: 1;
  min-width: 0;
}
.head__distunit {
  flex: none;
}
.head__distchev {
  color: var(--ink-3);
  transition: transform var(--dur) var(--ease);
}
.head__distchev.is-open {
  transform: rotate(180deg);
}
/* The rule stops at the panel's INNER edges (measured: x12, w306 inside a 330 panel) —
   it lines up with the fields rather than running wall to wall. */
.head__gpx {
  display: flex;
  align-items: center;
  margin: 0;
  color: var(--ink-3);
}
/* The file row is the URL field's second way in, so it hangs off that field at the
   label's own tight step (8) rather than the 16 that separates one pair from the next —
   but it does need SOME air: with none it sat flush on the field's bottom edge and read
   as part of the input. */
.head__panelinput + .head__gpx {
  margin-block-start: var(--space-2);
}
.head__gpxbtn {
  color: var(--ink-2);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
/* the input is the label's, so the whole phrase is the target and no bare file chrome
   lands in a panel built out of the app's own fields */
.head__gpxbtn input {
  display: none;
}
/* the (?) that replaced a line of caveats — same quiet treatment the planning rows use */
.head__gpxwhy {
  display: inline-flex;
  margin-left: var(--space-1);
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-3);
  cursor: help;
  transition: color var(--dur) var(--ease);
}
.head__gpxwhy:hover,
.head__gpxwhy:focus-visible {
  color: var(--ink);
}
.head__gpxerr {
  margin: 0;
  color: var(--ink-2);
}
/* The two answers to the pins offer. Text buttons rather than real ones: this sits inside
   a sentence in a quiet panel, and a pair of chrome buttons here would outweigh the
   "Import map file" affordance that caused it. Same treatment as head__gpxbtn, which is
   the other thing in this panel you click to make something happen. */
.head__gpxyes,
.head__gpxno {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  transition: color var(--dur) var(--ease);
}
.head__gpxyes {
  margin-left: var(--space-1);
  color: var(--ink);
}
.head__gpxno {
  margin-left: var(--space-2);
  color: var(--ink-3);
}
.head__gpxyes:hover,
.head__gpxyes:focus-visible,
.head__gpxno:hover,
.head__gpxno:focus-visible {
  color: var(--ink);
}
.head__paneldiv {
  width: 100%;
  /* 4 below, not 8: the row underneath already carries 8px of its own padding, and a
     full step here stacked the two into a 16px gap. 4 matches the panel's block-end
     padding so the hover box has the SAME breathing room above and below it. */
  margin: var(--space-2) 0 var(--space-1);
  border: 0;
  border-block-start: 1px solid var(--line);
}
/* The .menu__item atom's treatment, with this panel's own geometry: the negative inline
   margin lets the highlight breathe past the text while the icon still starts on the
   panel's 12px content edge, in line with the rule and the fields above it. */
.head__panelremove {
  /* .menu__item (atoms/controls.scss) supplies the row: background, ink, hover tint,
     concentric radius, transition, cursor, alignment. Only this panel's own geometry
     lives here. The radius comes out right because .head__panel repins
     --popover-item-radius to its own corner — see there. */
  display: flex;
  align-items: center;
  /* 12px — a 16px glyph on the panel's 12px content edge leaves the label starting at
     x40, which is where every other label in the panel starts */
  gap: var(--space-3);
  /* The highlight bleeds a full step past the content on each side, leaving it inset
     just 4px from the panel's edge rather than 8 — a menu row should read as spanning
     the panel, not as a chip floating inside it. Padding matches the bleed, so the icon
     still starts on the 12px content edge shared with the rule and the fields. */
  width: calc(100% + var(--space-2) * 2);
  margin-inline: calc(var(--space-2) * -1);
  /* pulls into the panel's floor so the highlight ends 4px off the bottom edge — the
     same 4px it has above it, without the panel itself thinning its padding (which
     would strand the lone field in "add" mode) */
  margin-block-end: calc(var(--space-2) * -1);
  padding: var(--space-2);
  font-size: var(--text-chrome);
  line-height: 1.2;
}

/* dates — a sibling of the trail affordance in the same meta row, so it needs its
   own positioning context for the panel below (the row's belongs to the trail one) */
.head__dates {
  position: relative;
  display: inline-flex;
}
/* the dates affordance (.head__datesbtn) borrows .head__add wholesale (gap, hover
   reveal, colour, ease); only the resolved state differs — a set date is content, not
   an invitation, so it holds full-time at the same weight the trail link's name does */
.head__datespanel {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  z-index: var(--z-menu);
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  width: max-content;
}
/* The month grid is a fixed 260px panel, and "Add dates" is the SECOND affordance in
   this row — so on a phone it opens around x=139 and runs 24px past the right edge,
   taking Sunday's whole column off-screen with it. A date you cannot tap is not a
   picker.
   Below 720px the panel resolves against .head__trail instead (already positioned,
   since it anchors the trail edit panel) so it starts at the row's left edge and has
   the full content width to sit in. `top` then measures from the row rather than the
   button, which on a wrapped two-line row is the more predictable of the two anyway.
   The desktop anchoring is untouched. */
@media (max-width: $bp-stack) {
  .head__dates {
    position: static;
  }
}
/* Centred across the grid, not flush to the panel's edge. `justify-self: start` put
   this label's first letter on the panel's content edge — but nothing in the calendar
   above it starts there: every glyph in the grid is CENTRED in a 32px column, so the
   word sat about half a cell left of the column of numbers and read as overhanging.
   Stretching it and letting .btn's own flexbox centre the label lines it up with the
   month name at the other end of the panel, which is the only other full-width row
   here. Given the day cells' height + corner so a hover reads as one of the panel's
   controls rather than as bare text. */
.head__dateclear {
  justify-self: stretch;
  block-size: var(--icon-btn);
  border-radius: var(--radius-2);
  color: var(--ink-3);
}
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss). The wash
   and the ink used to sit in two consecutive rules on the identical selector; they
   are one affordance, so they travel as one block now. */
@media (hover: hover) and (pointer: fine) {
  .head__dateclear:hover {
    background: var(--popover-hover);
    color: var(--ink);
  }
}

/* The trail affordance → link swap. Short and small: this is one line inside a page
   header, and anything longer reads as the header being unstable. Same tokens as
   every other family (see the motion note in atoms/controls.scss); reduced-motion is
   handled globally by the duration kill-switch. */
.trailswap-enter-active,
.trailswap-leave-active {
  transition:
    opacity var(--dur) var(--ease),
    translate var(--dur) var(--ease);
}
/* the link RISES into place — it is the result of an action, so it comes up from
   under the line rather than dropping onto it */
.trailswap-enter-from {
  opacity: 0;
  translate: 0 var(--space-1);
}
.trailswap-leave-to {
  opacity: 0;
  translate: 0 calc(-1 * var(--space-px));
}
</style>
