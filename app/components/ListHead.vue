<script setup lang="ts">
import { Copy, Globe, Trash2 } from "@lucide/vue";
import { displayUrl, parseTrailLink, safeUrl } from "~~/shared/trailLink";
import type { ListSnapshot } from "~~/shared/types";
import { copyText } from "~/utils/clipboard";

// The editor's title block: the list's name as a page title, with an optional link to
// the route it was packed for.
//
// One row sits under the title holding either "Add trail link" or the link itself, so
// the affordance occupies exactly the slot its result will — adding a link swaps the row
// in place rather than moving it. The affordance is revealed on hover (the Notion "Add
// icon / Add cover" idiom); hovering a resolved link raises a card with the destination
// and its actions. The title lives in here rather than beside it so DOM order matches
// visual order and tab order follows the eye.
const props = defineProps<{ snapshot: ListSnapshot }>();

const c = useGearList();
// null = at rest. "add" is a single URL box — the one job on the way in. "edit" is the
// full set, reached only by hovering an existing link, so naming it stays a deliberate
// second step rather than a second thing to fill in.
const mode = ref<"add" | "edit" | null>(null);
// Whether the link card is held open. On a fine pointer it also appears on hover; this
// is what a CLICK on the name does, and it's what makes the card reachable at all on a
// touch device, where there is no hover to reveal it.
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
const needsFit = import.meta.client && !CSS.supports("field-sizing", "content");
function fit() {
  const el = titleEl.value;
  if (!needsFit || !el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
// Covers the initial value and any that arrives from OUTSIDE this component — a list
// loading in, a collaborator's rename on a poll. Also on resize: the wrap point moves
// with the column, so a title that fits on one line in landscape may need two in
// portrait.
if (needsFit) {
  watch(() => props.snapshot.title, () => nextTick(fit), { immediate: true });
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

// Commits on @change (blur/Enter), the uncontrolled :value pattern the title uses — not
// per keystroke, so a half-typed URL never reaches the reducer (which would reject it).
function commitUrl(e: Event) {
  const value = (e.target as HTMLInputElement).value.trim();
  c.setMeta({ trailUrl: value });
  // clearing the URL clears the label too — a label with no link is unreachable state
  if (!value) c.setMeta({ trailLabel: "" });
}

function commitLabel(e: Event) {
  c.setMeta({ trailLabel: (e.target as HTMLInputElement).value.trim() });
}

function remove() {
  c.setMeta({ trailUrl: "", trailLabel: "" });
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

async function openFields(next: "add" | "edit") {
  mode.value = next;
  pinned.value = false;
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
onClickOutside(trailEl, () => {
  mode.value = null;
  pinned.value = false;
});
</script>

<template>
  <div class="head">
    <!-- A TEXTAREA, not an input: a list name is a page title and long ones must wrap.
         An <input> is single-line by definition — "Ryan's Summer Daypack 2026" scrolled
         sideways inside its box and you could only ever read the start of it. Rows is 1
         and it grows to fit (see autoGrow); Enter commits rather than inserting a
         newline, so the value stays the single line of text it is. -->
    <textarea
      ref="titleEl"
      class="field head__title"
      rows="1"
      :value="snapshot.title"
      placeholder="List name"
      aria-label="List name"
      autocorrect="off"
      spellcheck="false"
      @input="fit"
      @keydown.enter.prevent="($event.target as HTMLTextAreaElement).blur()"
      @change="c.setMeta({ title: ($event.target as HTMLTextAreaElement).value })"
    />

    <!-- One row under the title, holding either the affordance or its result — the
         "Add trail link" button occupies exactly the slot the link will, so adding one
         swaps the contents in place instead of moving the row across the title. The
         edit panel anchors to this row, so the link stays visible above it. -->
    <p ref="trailEl" class="head__trail">
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
        <Globe :size="14" :stroke-width="2" aria-hidden="true" />
        Add trail link
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
          @click="pinned = !pinned"
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
          <Globe v-else class="head__icon head__icon--fallback" :size="16" :stroke-width="2" aria-hidden="true" />
          <span class="head__name">{{ link.name }}</span>
        </button>

        <!-- Notion's link card: the destination in full, then the actions on it. Shown
             on hover (and on keyboard focus) rather than sitting in the layout, because
             the link is the content and Edit/Remove are only ever wanted deliberately.
             On a coarse pointer there IS no hover, so the media query below drops this
             back into the flow permanently — otherwise a phone could never reach it. -->
        <span v-if="!open" class="head__card popover" :class="{ 'is-pinned': pinned }">
          <img
            v-if="icon"
            class="head__cardicon"
            :src="icon"
            alt=""
            width="14"
            height="14"
          />
          <Globe v-else class="head__cardicon head__icon--fallback" :size="14" :stroke-width="2" aria-hidden="true" />
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
            <!-- 14, tracking the card's own type: the reference runs its glyphs at the
                 same size as the text beside them (12/12), so this holds that 1:1 ratio
                 at 14. 16 is the size for marks beside 16px text (the link row) and reads
                 oversized in here. Stroke drops to 1.5 — the reference's icons are FILLED
                 paths (stroke:none), so a stroked outline at the house's 2 reads heavier
                 than the thing it imitates. 1.75, not 1.5: at 14 the lighter stroke went
                 a touch spindly beside the text it sits in, and this is the smallest step
                 that reads as the same weight. -->
            <Copy :size="14" :stroke-width="1.75" aria-hidden="true" />
          </button>
          <!-- no Remove here: the card mirrors Notion's, where removal lives one level
               in, behind Edit (the fields row below carries it). Keeping a destructive
               action out of a surface that appears on hover is also just safer. -->
          <!-- measured: the reference runs 6px gaps between the mark, the URL and the
               copy glyph, then opens to 12px before "Edit" — the icon belongs to the URL
               it acts on; the word is a separate control. -->
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

      <!-- The edit panel, anchored under the row so the link stays visible above it (as
           in Notion). No "Done": the inputs commit on change (blur/Enter) like every
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
        <label class="head__panellabel" :for="`${fieldsId}-url`">Page or URL</label>
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
          <hr class="head__paneldiv" />
          <button type="button" class="menu__item head__panelremove" @click="remove">
            <Trash2 :size="16" :stroke-width="1.5" aria-hidden="true" />
            Remove link
          </button>
        </template>
      </span>
    </p>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.head__title {
  width: 100%;
  /* the page-title step — a document title, not a section heading. Well above the 16px
     threshold that triggers iOS Safari's focus-zoom, so .field's literal-1rem
     workaround (controls.scss) doesn't apply here. */
  font-size: var(--text-page-title);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.02em;
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
  gap: var(--space-2);
  min-width: 0;
  min-height: 1.5em;
}
.head__link {
  display: inline-flex;
  align-items: baseline;
  /* the mark and the name are one object — --space-1, matching the read views
     (whose comment records that --space-2 let the icon drift off the text) */
  gap: var(--space-1);
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
  /* On a phone the card is IN FLOW (see below), and side by side with the name the two
     split the row — the name got the smaller half and ellipsed to "Timberline Tra…"
     while the card showed a URL that was itself truncated. Neither was readable, and
     the name is the content. Wrapping lets the card drop to its own line and gives the
     name the full width; on a fine pointer the card is absolutely positioned, so this
     has nothing to act on and is inert. */
  flex-wrap: wrap;
  row-gap: var(--space-2);
  /* takes the whole row so the wrapped card's 100% basis has something real to resolve
     against — inline-flex alone sizes to the NAME, and the card then measured wider
     than the phone. The fine-pointer branch puts this back to content-sized, where the
     card floats and the anchor shouldn't claim a full row. */
  flex: 1 1 100%;
}
/* The link card. DEFAULT (coarse pointer / no hover) is in-flow and permanent: a phone
   has no hover, so a reveal-on-hover card would put Edit and Remove out of reach
   entirely. Fine pointers get the floating version below. */
.head__card {
  display: inline-flex;
  align-items: center;
  /* wider than the icon-to-its-own-text step: the glyph belongs to the URL it acts on,
     "Edit" is a separate control */
  gap: var(--space-2);
  min-width: 0;
  /* Full width once it has wrapped onto its own line, so the URL gets the room the
     name was taking from it rather than ellipsing at both ends. SHRINK IS 1, not 0:
     with 0 the card can't go below its content and the URL's intrinsic width pushed
     it (and the Edit button) clean off the side of the phone. */
  flex: 1 1 100%;
  max-width: 100%;
  margin-inline-start: 0;
  font-size: var(--text-chrome);
  /* tight leading, not the inherited 1.5 — the card's height is content + padding, and
     1.5 alone pushed it past the reference's 32px */
  line-height: 1.2;
}
/* muted, not full ink — measured off the reference, where the URL sits at the faint step
   and the ACTION beside it carries the emphasis. (I'd darkened this on a guess; the real
   thing is the other way round.) */
/* block, not the browser's default inline: an inline <img> sits on the text baseline and
   reserves descender space under it, which was making the card 34px against the
   reference's 32 */
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
   narrowest phone. ONE rule for both pointer branches. */
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
   font-size is load-bearing — .btn hard-sets --text-sm (16px), which would otherwise
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
  /* the card lifts out of the flow and floats under the link, revealed on hover.
     top:100% with no gap keeps its box FLUSH to the link's, so travelling down into it
     never crosses dead space and dismisses the thing you were reaching for — the card's
     own padding supplies the visual offset instead. */
  .head__card {
    position: absolute;
    top: 100%;
    inset-inline-start: 0;
    /* menu layer, not --z-float: this is a popover of actions, and it should sit under
       the toast/dialog surfaces rather than competing with them */
    z-index: var(--z-menu);
    margin-inline-start: 0;
    /* Undo the wrapped-on-its-own-line sizing the coarse-pointer default sets. Floating,
       the card is out of flow and sizes to its CONTENT, bounded by the base rule's
       `max-width: 100%` — which is the page column, since .head__trail is the
       containing block. Content-sized but never past the screen edge. */
    flex: 0 0 auto;
    width: max-content;
    /* --radius-3 is the small-card step; inner surfaces derive from it with calc() so a
       nested curve can never end up rounder than the box holding it. */
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-3);
    /* A 1px ring plus a TIGHT drop, measured off the reference. --shadow-soft is built
       for big anchored menus — its 48px second layer reads mushy under a 32px card, and
       it deliberately carries no ring ("the shadow alone defines the edge"), which is
       exactly what leaves a small surface looking soft-edged. Local override only; the
       token is right for what it was written for. */
    box-shadow:
      0 0 0 1px var(--line-2),
      0 4px 12px -2px rgb(0 0 0 / 0.08);
    white-space: nowrap;
    opacity: 0;
    visibility: hidden;
    transition:
      opacity var(--dur) var(--ease),
      visibility var(--dur) var(--ease);
  }
  .head__anchor {
    flex: 0 1 auto;
  }
  .head__anchor:hover .head__card,
  .head__anchor:focus-within .head__card,
  .head__card.is-pinned {
    opacity: 1;
    visibility: visible;
  }
  /* opacity only — the transition list lives on the base rule (see the note there) */
  .head__add {
    opacity: 0;
  }
  /* the whole title block is the reveal target, not the button itself — the affordance
     comes up as the pointer approaches the title, so it's found without having to land
     on invisible text first */
  .head:hover .head__add {
    opacity: 1;
  }
}
/* keyboard focus always reveals, at every pointer type — outside the media query so a
   tabbing user is never left with an invisible control. focus-within on the block covers
   the button's own focus too, so it doesn't need its own selector. */
.head:focus-within .head__add {
  opacity: 1;
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
  /* no flex gap — every gap here is set explicitly below, because the reference's rhythm
     isn't uniform (13 label→field, 18 field→label, 12 field→rule) */
  gap: 0;
  /* 330px and a 12px inset, measured off the reference */
  width: min(20.625rem, 100%);
  /* Uniform. The Remove row pulls ITSELF into this padding (below) rather than the panel
     thinning its floor — in "add" mode there is no Remove row, and a thinned floor left
     the lone URL field crammed against the bottom edge with a full step above it. */
  padding: var(--space-3);
  border-radius: var(--radius-3);
  /* .popover pins --popover-item-radius to its own (larger) corner; this panel overrides
     that corner, so it repins the item radius too — otherwise .menu__item rows inside
     would curve more than the box holding them. */
  --popover-item-radius: calc(var(--radius-3) - var(--space-1));
  /* same reasoning as the card: ring + a contained drop, rather than --shadow-soft's
     ringless 48px spread */
  box-shadow:
    0 0 0 1px var(--line-2),
    0 14px 28px -6px rgb(0 0 0 / 0.2);
  text-align: start;
}
/* 12px + medium weight, both measured off the reference — the smaller of the two chrome
   steps, so the labels stay subordinate to the 14px fields and row beneath them. A label
   belongs to the field UNDER it, so it sits closer to that field (8) than the field above
   sits to it (16, set on the adjacent-sibling rule below). */
.head__panellabel {
  margin-block-end: var(--space-2);
  color: var(--ink-3);
  font-size: var(--text-micro);
  font-weight: 500;
  line-height: 1.2; /* 14.4px — the reference's label box, measured */
}
/* filled, unlike the borderless .field used everywhere else: inside a floating panel
   there's no surrounding structure to imply where the input begins, so the fill IS the
   boundary. Each label sits above its own field, so a placeholder never has to stand in
   for one. */
.head__panelinput {
  width: 100%;
  /* 2em — the reference's fields are 28px at 14px type, exactly twice the font size.
     --field-h (36px) came out visibly taller because this input is locked to 16px (see
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
  /* stays at 16px while the labels above drop to 12px: the reference uses 14px here, but
     anything under 16px makes iOS Safari zoom the page on focus (atoms/controls.scss) */
  font-size: 1rem;
  font-family: inherit;
}
.head__panelinput:focus {
  outline: none;
}
.head__panelinput + .head__panellabel {
  margin-block-start: var(--space-4);
}
/* The rule stops at the panel's INNER edges (measured: x12, w306 inside a 330 panel) —
   it lines up with the fields rather than running wall to wall. */
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
  /* 12px — the one figure both measurements of the reference agreed on: its label starts
     at x40 with the panel's content edge at x12, leaving a 16px glyph and a 12px gap */
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
</style>
