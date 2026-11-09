<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Delete02Icon, Edit02Icon, MinusSignIcon, PlusSignIcon, RemoveCircleIcon } from "@hugeicons/core-free-icons";
import type { Unit } from "~~/shared/types";
import { VAULT_NAME_MAX, type VaultEntry, type VaultKitPart } from "~~/shared/vault";
import type { GearGlyph } from "~~/shared/gearGlyph";
import { formatWeight, itemDisplayName } from "~~/shared/weights";
import { VAULT_KIT_QTY_MAX, kitPartRefs } from "~~/shared/vaultKit";
import { strongVaultRows } from "~~/shared/vaultSearch";

// One kit on My Gear's Kits tab, drawn the way a kind is on the Gear tab: its name as
// the heading, with the collapse chevron, and its items as rows of gear beneath —
// the same VaultGearRow, so an item reads exactly as it does on its own (Ryan: "can
// kits use this kind of structure and visual formatting?"). Then "Add an item", the
// way a list's folder ends.
//
// Everything about a kit is edited here: the heading is its name, each item's count
// and removal sit where a row's edit and remove would, and "Make it a single piece" is
// the way back. Each change sends the WHOLE set, which is what the vault's kit op
// takes. A kit keeps at least one item: emptying one would turn it back into a piece
// at the weight it showed, which is not what taking the last item out means.
//
// `starting` is a piece on its way to being a kit ("Make it a kit", or New kit): the
// same section with no items yet, its "Add an item" focused, and the first item makes
// it a kit. Escape on that empty line gives up on it.
const props = defineProps<{
  kit: VaultEntry;
  /** every piece of your gear by id: an item's own row, and its owned count */
  gearById: ReadonlyMap<number, VaultEntry>;
  unit: Unit;
  /** a change to this kit is saving: its controls wait */
  busy?: boolean;
  collapsed?: boolean;
  starting?: boolean;
}>();
const emit = defineEmits<{
  toggle: [];
  /** the kit's items as they should now be, and its own weight */
  kit: [parts: { id: number; qty: number }[], ownWeightMg: number];
  rename: [name: string];
  unkit: [];
  remove: [];
  /** "Make it a kit" given up on before an item went in */
  cancel: [];
  /** an item's own row asked for its piece: open it, change its icon or unit */
  edit: [entry: VaultEntry];
  icon: [entry: VaultEntry, glyph: GearGlyph | null];
  unit: [entry: VaultEntry, unit: Unit];
}>();

const isKit = computed(() => props.kit.kind === "kit");
const name = computed(() => itemDisplayName(props.kit.brand, props.kit.name, props.kit.variant));
const parts = computed<VaultKitPart[]>(() => props.kit.parts ?? []);
// each item as the piece it is; one put away is no longer in your gear, so it is
// listed by the name the kit kept for it, marked, and can only come out
const rows = computed(() => parts.value.map((part) => ({ part, entry: part.removed ? null : props.gearById.get(part.id) ?? null })));
const liveCount = computed(() => parts.value.filter((p) => !p.removed).length);

function send(next: { id: number; qty: number }[], own = props.kit.ownWeightMg ?? 0) {
  if (!props.busy) emit("kit", next, own);
}
// A kit holds no more of a piece than you own (the vault holds it to that too).
const ownedOf = (id: number) => props.gearById.get(id)?.owned ?? 1;
const partMax = (id: number) => Math.min(VAULT_KIT_QTY_MAX, ownedOf(id));
// The count only where it can change: a kit whose every item is one of one shows none,
// rather than a column of dead − 1 + controls.
const counts = computed(() => rows.value.some(({ part }) => !part.removed && (part.qty > 1 || partMax(part.id) > 1)));
function step(id: number, by: number) {
  send(kitPartRefs(parts.value).map((r) => (r.id === id ? { id, qty: Math.min(partMax(id), Math.max(1, r.qty + by)) } : r)));
}
function drop(id: number) {
  send(kitPartRefs(parts.value).filter((r) => r.id !== id));
}
const canDrop = (p: VaultKitPart) => !!p.removed || liveCount.value > 1;

// The name is the heading, as a list's folder name is: saved on change (Enter or
// leaving the field); Escape puts it back, and so does a blank.
function commitName(e: Event) {
  const el = e.target as HTMLInputElement;
  const next = el.value.trim();
  if (!next || next === props.kit.name) el.value = props.kit.name;
  else emit("rename", next);
}
function revertName(e: KeyboardEvent) {
  const el = e.target as HTMLInputElement;
  el.value = props.kit.name;
  el.blur();
}

// "Add an item": your other pieces — not kits (one level deep), not this one, not one
// it already holds — by the picker's search, which offers real matches only.
const addQuery = ref("");
const addEl = useTemplateRef<HTMLInputElement>("addEl");
const choices = computed(() => {
  const q = addQuery.value.trim();
  if (!q) return [];
  const taken = new Set(parts.value.map((p) => p.id));
  const pool = [...props.gearById.values()].filter((g) => g.kind !== "kit" && g.id !== props.kit.id && !taken.has(g.id));
  return strongVaultRows(pool, q);
});
// The field stays live while a change saves (a disabled field drops its focus, and the
// next item is the next thing you type); the cursor is put back once the save lands.
let refocus = false;
function add(g: VaultEntry) {
  if (props.busy) return;
  addQuery.value = "";
  refocus = true;
  send([...kitPartRefs(parts.value), { id: g.id, qty: 1 }]);
}
watch(
  () => props.busy,
  (busy) => {
    if (busy || !refocus) return;
    refocus = false;
    nextTick(() => addEl.value?.focus());
  },
);
function onAddKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    if (choices.value[0]) add(choices.value[0]);
  } else if (e.key === "Escape") {
    if (addQuery.value) addQuery.value = "";
    else if (!isKit.value) emit("cancel");
  }
}
watch(
  () => props.starting,
  (on) => {
    if (on) nextTick(() => addEl.value?.focus());
  },
  { immediate: true },
);

// a menu on one of the item rows lifts the section's collapse clip while it is open,
// as a kind's body does (atoms/folder.scss)
const overlays = ref(0);
const onOverlay = (open: boolean) => (overlays.value = Math.max(0, overlays.value + (open ? 1 : -1)));
</script>

<template>
  <section class="folder kitsec" :data-collapsed="collapsed ? true : null">
    <header class="folder__head">
      <div class="folder__title">
        <input
          class="field folder__name"
          :value="kit.name"
          :maxlength="VAULT_NAME_MAX"
          :aria-label="`Name of ${name}`"
          autocomplete="off"
          spellcheck="false"
          @change="commitName"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
          @keydown.esc="revertName"
        />
        <NestChevron folder :collapsed="!!collapsed" :label="name" @toggle="emit('toggle')" />
      </div>
      <div class="folder__actions">
        <span class="t-num t-muted kitsec__total">{{ formatWeight(kit.weightMg, unit) }}</span>
        <button
          v-if="isKit"
          type="button"
          class="btn btn--icon btn--ghost ink-quiet"
          :title="`Remove ${name}`"
          :aria-label="`Remove ${name} from My Gear`"
          @click="emit('remove')"
        >
          <HugeiconsIcon :icon="Delete02Icon" :size="16" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>
    </header>

    <div class="folder__body">
      <div class="folder__bodyinner" :class="{ 'is-overlay-open': overlays > 0 }">
        <ul class="kitsec__list" :aria-label="`Items in ${name}`">
          <template v-for="{ part, entry } in rows" :key="part.id">
            <VaultGearRow
              v-if="entry"
              :entry="entry"
              :unit="unit"
              @edit="emit('edit', entry)"
              @icon="(g: GearGlyph | null) => emit('icon', entry, g)"
              @unit="(u: Unit) => emit('unit', entry, u)"
              @overlay-toggle="onOverlay"
            >
              <template #actions>
                <!-- how many the kit holds: held out of sight, not dropped, on a row
                     that can't change, so the columns stay put down the kit -->
                <span v-if="counts" class="kitsec__step" :class="{ 'is-idle': part.qty <= 1 && partMax(part.id) <= 1 }">
                  <button
                    type="button"
                    class="btn btn--icon btn--ghost ink-quiet"
                    :disabled="busy || part.qty <= 1"
                    :aria-label="`One fewer ${part.name} in ${name}`"
                    @click="step(part.id, -1)"
                  >
                    <HugeiconsIcon :icon="MinusSignIcon" :size="14" :stroke-width="2" aria-hidden="true" />
                  </button>
                  <span class="t-sm t-num kitsec__count" :aria-label="`${part.qty} in the kit`">{{ part.qty }}</span>
                  <button
                    type="button"
                    class="btn btn--icon btn--ghost ink-quiet"
                    :disabled="busy || part.qty >= partMax(part.id)"
                    :aria-label="`One more ${part.name} in ${name}`"
                    :title="part.qty >= ownedOf(part.id) ? `You own ${ownedOf(part.id)}. Change how many in its Edit.` : undefined"
                    @click="step(part.id, 1)"
                  >
                    <HugeiconsIcon :icon="PlusSignIcon" :size="14" :stroke-width="2" aria-hidden="true" />
                  </button>
                </span>
                <button
                  type="button"
                  class="btn btn--icon btn--ghost ink-quiet"
                  :title="`Edit ${part.name}`"
                  :aria-label="`Edit ${part.name}`"
                  @click="emit('edit', entry)"
                >
                  <HugeiconsIcon :icon="Edit02Icon" :size="16" :stroke-width="2" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="btn btn--icon btn--ghost ink-quiet"
                  :disabled="busy || !canDrop(part)"
                  :aria-label="`Take ${part.name} out of ${name}`"
                  :title="canDrop(part) ? `Take ${part.name} out of the kit` : 'A kit holds at least one item'"
                  @click="drop(part.id)"
                >
                  <HugeiconsIcon :icon="RemoveCircleIcon" :size="16" :stroke-width="2" aria-hidden="true" />
                </button>
              </template>
            </VaultGearRow>
            <!-- put away from My Gear: listed by name, it stops counting and can only come out -->
            <li v-else class="kitsec__line kitsec__line--gone">
              <span class="kitsec__name t-clip">{{ itemDisplayName(part.brand, part.name, part.variant) }} <span class="kitsec__gone">· removed</span></span>
              <button
                type="button"
                class="btn btn--icon btn--ghost ink-quiet"
                :disabled="busy"
                :aria-label="`Take ${part.name} out of ${name}`"
                @click="drop(part.id)"
              >
                <HugeiconsIcon :icon="RemoveCircleIcon" :size="16" :stroke-width="2" aria-hidden="true" />
              </button>
            </li>
          </template>
          <!-- a weight of the kit's own (a group saved off a list whose heading had one) -->
          <li v-if="kit.ownWeightMg" class="kitsec__line">
            <span class="kitsec__name">Its own weight</span>
            <span class="t-num kitsec__weight">{{ formatWeight(kit.ownWeightMg, unit) }}</span>
            <button
              type="button"
              class="btn btn--icon btn--ghost ink-quiet"
              :disabled="busy"
              :aria-label="`Remove ${name}'s own weight`"
              title="Remove its own weight"
              @click="send(kitPartRefs(parts), 0)"
            >
              <HugeiconsIcon :icon="RemoveCircleIcon" :size="16" :stroke-width="2" aria-hidden="true" />
            </button>
          </li>
        </ul>

        <div class="kitsec__add">
          <input
            ref="addEl"
            v-model="addQuery"
            class="field"
            placeholder="Add an item"
            :aria-label="`Add an item from your gear to ${name}`"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            @keydown="onAddKey"
          />
          <ul v-if="choices.length" class="kitsec__choices">
            <li v-for="g in choices" :key="g.id">
              <button type="button" class="kitsec__choice" @click="add(g)">
                <span class="t-clip">{{ itemDisplayName(g.brand, g.name, g.variant) }}</span>
                <span class="t-sm t-num t-muted">{{ formatWeight(g.weightMg, unit) }}</span>
              </button>
            </li>
          </ul>
          <p v-else-if="addQuery.trim()" class="t-sm t-muted kitsec__none">None of your gear matches. Add it to My Gear first.</p>
        </div>
        <!-- the way back: one piece weighing what the kit does, its items left as the
             pieces they are, with Undo on the page's toast -->
        <button v-if="isKit" type="button" class="btn btn--quiet t-sm ink-quiet kitsec__unkit" :disabled="busy" @click="emit('unkit')">
          Make it a single piece
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* the rows are VaultGearRow's own; the list only stacks them, as a kind's does */
.kitsec__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
/* the kit's weight beside its remove, quieter than the heading it belongs to */
.kitsec__total {
  margin-inline-end: var(--space-2);
}
/* The heading's remove centres its glyph, as the row buttons under it do, so the bin
   stands over the items' remove-circles. The list folder's atom pushes a heading glyph
   to the box's edge (atoms/folder.scss), which put it 8–13px right of the column. */
.folder__actions .btn--icon {
  justify-content: center;
}
/* a line that isn't a piece of your gear (one put away, the kit's own weight): the
   row's rhythm and hairline, its name under the rows' names, its weight in their
   weight column's place */
.kitsec__line {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding-block: var(--space-2);
  padding-inline-start: var(--gear-type-indent);
  border-top: 1px solid var(--line);
  color: var(--ink-2);
}
.kitsec__name {
  flex: 1;
  min-width: 0;
}
.kitsec__line--gone {
  color: var(--ink-3);
}
.kitsec__gone {
  font-style: italic;
}
.kitsec__step {
  display: inline-flex;
  align-items: center;
}
.kitsec__step.is-idle {
  visibility: hidden;
}
.kitsec__count {
  min-width: 2.5ch;
  text-align: center;
  color: var(--ink);
}
/* "Add an item", under the items' names, as a list folder's add row sits */
.kitsec__add {
  padding: var(--space-2) 0 0 var(--gear-type-indent);
  border-top: 1px solid var(--line);
}
.kitsec__none {
  margin: var(--space-1) 0 0;
}
.kitsec__choices {
  margin: var(--space-1) 0 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-2);
  overflow: hidden;
}
.kitsec__choices li + li {
  border-top: 1px solid var(--line);
}
.kitsec__choice {
  display: flex;
  width: 100%;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.kitsec__choice:hover,
.kitsec__choice:focus-visible {
  background: var(--popover-hover);
}
.kitsec__unkit {
  margin: var(--space-2) 0 0 var(--gear-type-indent);
}
/* a kit after a kit: the kinds' own spacing between sections */
.kitsec + .kitsec {
  margin-top: var(--space-6);
}
</style>
