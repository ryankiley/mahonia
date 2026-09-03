<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { categoryColor, FOLDER_PALETTE } from "~~/shared/categories";
import { MAX_PEOPLE } from "~~/shared/ops";
import { filterItemsForPerson, personColor, sortedPeople } from "~~/shared/people";
import type { Person } from "~~/shared/types";

// Who's on this trip — the one place people are added, renamed, recolored and
// removed. Assigning gear to them happens on the rows ("Who carries this"), not here.
//
// Reads the controller directly like every editor surface (module singleton, no
// prop drilling); the parent only decides when the dialog exists. Lazy-mounted
// already open, which BaseModal's `appear` is built for.

const emit = defineEmits<{ close: [] }>();

const c = useGearList();
const people = computed(() => sortedPeople(c.snapshot.value?.people));
const atCap = computed(() => people.value.length >= MAX_PEOPLE);

// ---- add ----
const draft = ref("");
const draftEl = useTemplateRef<HTMLInputElement>("draftEl");
// The whole job on a fresh open is a name, Enter, a name, Enter — start
// in the field. BaseModal's own focus move yields to a caller that already
// placed focus inside (its documented contract), so this wins the race cleanly.
onMounted(() => draftEl.value?.focus());
function add() {
  const name = draft.value.trim();
  if (!name || atCap.value) return;
  c.addPerson(name);
  draft.value = "";
  // stay in the field — a crew is usually typed in one sitting, name after name
  draftEl.value?.focus();
}

// ---- rename ----
function rename(p: Person, e: Event) {
  const el = e.target as HTMLInputElement;
  const name = el.value.trim();
  if (name) c.updatePerson(p.id, { name });
  // a person keeps a name (the reducer ignores an empty rename) — snap the field
  // back so it can't show a blank the list doesn't hold
  else el.value = p.name;
}

// ---- recolor ----
// one open swatch strip at a time, toggled from the person's own dot
const recoloring = ref<string | null>(null);
function setColor(p: Person, colorKey: string) {
  c.updatePerson(p.id, { colorKey });
  recoloring.value = null;
}

// ---- remove ----
// An ARMED second click instead of a stacked confirm dialog: two modals fight
// over Escape and the focus trap, and the act is small — the person's items stay,
// they just go back up for grabs. Arming disarms itself when focus leaves the row.
// The armed label says what the click costs: the name is the cheap part, the N
// assignments made one row at a time are the expensive one, and they don't come
// back with a re-typed name.
const arming = ref<string | null>(null);
const carriedCount = (id: string) =>
  filterItemsForPerson(c.snapshot.value?.items ?? [], id).length;
// palette membership, for the strip below — an 11th person walks off the ten
// named hues onto a procedural one, and the strip must still show a selection
const inPalette = (key?: string) => !!key && (FOLDER_PALETTE as readonly string[]).includes(key);
function remove(p: Person) {
  if (arming.value !== p.id) {
    arming.value = p.id;
    return;
  }
  arming.value = null;
  if (recoloring.value === p.id) recoloring.value = null;
  c.removePerson(p.id);
}
</script>

<template>
  <BaseModal :open="true" label="People on this trip" @close="emit('close')">
    <h2 class="t-label">People</h2>
    <p class="t-sm t-muted dlg__lede">
      Name who’s on this trip, then mark who carries what as you go down the list.
      Removing someone keeps their gear — it just goes back up for grabs.
      Filter to Unassigned to see what nobody has yet.
    </p>

    <ul v-if="people.length" class="ppl__list">
      <li v-for="p in people" :key="p.id" class="ppl__item" @focusout="arming === p.id && (arming = null)">
        <div class="ppl__row">
          <button
            type="button"
            class="btn btn--icon btn--ghost ppl__dotbtn"
            :aria-label="`Change ${p.name}’s color`"
            :aria-expanded="recoloring === p.id"
            @click="recoloring = recoloring === p.id ? null : p.id"
          >
            <span class="swatch" :style="{ background: personColor(p) }" aria-hidden="true" />
          </button>
          <input
            class="field ppl__name"
            :value="p.name"
            :aria-label="`Rename ${p.name}`"
            autocomplete="off"
            spellcheck="false"
            maxlength="60"
            @change="rename(p, $event)"
            @keydown.enter="($event.target as HTMLInputElement).blur()"
          />
          <button
            type="button"
            class="btn btn--quiet ppl__remove"
            :class="{ 'is-arming': arming === p.id }"
            :aria-label="arming === p.id ? `Really remove ${p.name}? ${carriedCount(p.id)} item${carriedCount(p.id) === 1 ? '' : 's'} go back up for grabs` : `Remove ${p.name}`"
            @click="remove(p)"
          >
            <template v-if="arming === p.id">Remove?{{ carriedCount(p.id) ? ` · ${carriedCount(p.id)} item${carriedCount(p.id) === 1 ? "" : "s"}` : "" }}</template>
            <HugeiconsIcon v-else :icon="Delete02Icon" :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
        <div v-if="recoloring === p.id" class="ppl__swatches" role="group" :aria-label="`${p.name}’s color`">
          <button
            v-for="(key, i) in FOLDER_PALETTE"
            :key="key"
            type="button"
            class="ppl__swatchbtn"
            :class="{ 'is-active': (p.colorKey ?? 'other') === key }"
            :aria-label="`Color ${i + 1} of ${FOLDER_PALETTE.length}`"
            :aria-pressed="(p.colorKey ?? 'other') === key"
            @click="setColor(p, key)"
          >
            <span class="swatch" :style="{ background: categoryColor(key) }" aria-hidden="true" />
          </button>
          <!-- an 11th/12th person's auto-color is a procedural hue past the ten named
               ones — show it as the standing selection, or the strip claims nothing
               is chosen. Not a button: it IS the current pick, there's nothing to do. -->
          <span
            v-if="p.colorKey && !inPalette(p.colorKey)"
            class="ppl__swatchbtn is-active"
            role="img"
            :aria-label="`${p.name}’s current color`"
          >
            <span class="swatch" :style="{ background: categoryColor(p.colorKey) }" aria-hidden="true" />
          </span>
        </div>
      </li>
    </ul>

    <form class="ppl__add" @submit.prevent="add">
      <input
        ref="draftEl"
        v-model="draft"
        class="field ppl__addfield"
        :placeholder="people.length ? 'Add another person' : 'Add a person — “Sam”'"
        aria-label="Add a person"
        autocomplete="off"
        spellcheck="false"
        maxlength="60"
        :disabled="atCap"
      />
      <button type="submit" class="btn btn--ghost ppl__addbtn" :disabled="atCap || !draft.trim()">Add</button>
    </form>
    <!-- the cap, said at the moment it starts refusing input -->
    <p v-if="atCap" class="t-sm t-muted">Up to {{ MAX_PEOPLE }} people on a trip.</p>

    <div class="dlg__actions">
      <button class="btn btn--primary" @click="emit('close')">Done</button>
    </div>
  </BaseModal>
</template>

<style scoped lang="scss">
/* overlay + shell + action row come from atoms/dialog.scss; this is the list */
.ppl__list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: min(48vh, 22rem); /* a full crew scrolls inside, like the vault picker */
  overflow-y: auto;
  overscroll-behavior: contain;
}
.ppl__item + .ppl__item {
  border-top: 1px solid var(--line);
}
.ppl__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-block: var(--space-2);
}
/* The row's NAME COLUMN, defined once: where the dot's box ends and everything that
   lines up with a name begins. The add row's indent and the palette strip both read
   it, so the three can't drift apart. */
.ppl__list,
.ppl__add {
  --ppl-dotw: calc(var(--swatch) + var(--space-3));
  --ppl-namecol: calc(var(--ppl-dotw) + var(--space-2));
}
.ppl__dotbtn {
  flex: none;
  /* The DOT sits on the row's left edge, flush with the hairline dividing the rows.
     .btn--icon centres a 10px swatch in a 32px box, so the drawn dot started 11px in
     and the whole column — dot, name, add field, palette — read as inset from its own
     rule. Left-align the swatch and let the box keep only the width it needs; the
     atom's min-height still gives the button the full row height for a thumb, so what
     shrinks is dead space to the RIGHT of the dot, not the target you aim at. */
  justify-content: flex-start;
  width: var(--ppl-dotw);
}
.ppl__name {
  flex: 1;
  min-width: 0;
}
.ppl__remove {
  flex: none;
}
/* armed = about to happen — the row's one moment of red, at rest so it's read
   before the second press (the delete-list rule, in miniature: colour is
   reserved for the destructive act, and this is one — their assignments don't
   come back with a re-typed name) */
.ppl__remove.is-arming {
  color: var(--danger);
  font-weight: 600;
}
.ppl__swatches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: 0 0 var(--space-2) var(--ppl-namecol);
}
.ppl__swatchbtn {
  appearance: none;
  border: 0;
  background: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: var(--icon-btn);
  block-size: var(--icon-btn);
  border-radius: var(--radius-2);
}
/* the interactive halves are BUTTON-scoped: the standing procedural-color mark
   below wears this class for the box alone, and a pointer cursor or a hover
   plate on it would offer an affordance the element doesn't have */
button.ppl__swatchbtn {
  cursor: pointer;
}
button.ppl__swatchbtn:hover,
.ppl__swatchbtn.is-active {
  background: var(--lit);
}
.ppl__swatchbtn:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}
/* Standing ALONE — nobody named yet, so the list above it doesn't render — this is
   a plain form with room above it, aligned to the dialog like any other field. */
.ppl__add {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
/* After the list, it IS that list's last row: the same leading gutter .ppl__swatches
   takes (the dot button's box plus the row gap) so the field sits in the NAME column
   instead of out at the dialog's edge, and the same hairline and block padding the
   rows divide with. Typing a name then happens exactly where the names are.
   Sibling-scoped rather than unconditional — with no list above, that indent would
   be an inset from nothing and the rule a stray line under nothing. */
.ppl__list + .ppl__add {
  /* .dlg is a flex COLUMN with a --space-3 gap between its blocks; cancelling it is
     what lets this row butt straight onto the list, so its hairline falls on the same
     rhythm as the ones dividing the rows rather than 12px below it. */
  margin-top: calc(-1 * var(--space-3));
  padding-block: var(--space-2);
  padding-left: var(--ppl-namecol);
  border-top: 1px solid var(--line);
}
.ppl__addfield {
  flex: 1;
  min-width: 0;
}
/* the WORD on the rule, like the remove icon in the rows above it: .btn's 16px inline
   padding is hit padding, and on the row's trailing edge it pushed "Add" that far in
   from the hairline everything else lines up with. Trailing side only — the leading
   padding still holds it off the field it follows. */
.ppl__addbtn {
  padding-inline: var(--space-3) 0;
  /* …and the row's HEIGHT comes from the field beside it, exactly as a person row's
     comes from its name field. .btn's 40px floor is 4px past that, which made this
     row taller than every row above it and put its hairline off the rhythm. Stretch
     keeps the button a full-height target without letting it set the height. */
  min-height: 0;
  align-self: stretch;
}
</style>
