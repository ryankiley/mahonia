<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { categoryColor, FOLDER_PALETTE } from "~~/shared/categories";
import { MAX_PEOPLE } from "~~/shared/ops";
import { filterItemsForPerson, personColor, sortedPeople } from "~~/shared/people";
import type { Person } from "~~/shared/types";

// Who's on this trip — the one place people are added, renamed, recolored and
// removed. Assigning gear to them happens on the rows ("Carried by"), not here.
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
// The whole job on a fresh open is "type Ryan, Enter, type Matt, Enter" — start
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
      Filter to Unassigned to work through what’s left.
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
            :aria-label="arming === p.id ? `Really remove ${p.name}` : `Remove ${p.name}`"
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
        :placeholder="people.length ? 'Add another person' : 'Add a person — “Ryan”'"
        aria-label="Add a person"
        autocomplete="off"
        spellcheck="false"
        maxlength="60"
        :disabled="atCap"
      />
      <button type="submit" class="btn btn--ghost" :disabled="atCap || !draft.trim()">Add</button>
    </form>
    <!-- the cap, said only once it's near enough to matter -->
    <p v-if="atCap" class="t-sm t-muted">Up to {{ MAX_PEOPLE }} people per list.</p>

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
.ppl__dotbtn {
  flex: none;
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
  padding: 0 0 var(--space-2) calc(var(--icon-btn) + var(--space-2));
}
.ppl__swatchbtn {
  appearance: none;
  border: 0;
  background: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: var(--icon-btn);
  block-size: var(--icon-btn);
  border-radius: var(--radius-2);
}
.ppl__swatchbtn:hover,
.ppl__swatchbtn.is-active {
  background: var(--lit);
}
.ppl__swatchbtn:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}
.ppl__add {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.ppl__addfield {
  flex: 1;
  min-width: 0;
}
</style>
