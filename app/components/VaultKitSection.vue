<script setup lang="ts">
import { IconCircleMinus, IconMinusMedium, IconPlusMedium, IconTrashCan } from "~/icons/central";
import { SvgIcon } from "~/utils/icon";
import type { Unit } from "~~/shared/types";
import { VAULT_NAME_MAX, type VaultEntry, type VaultKitPart } from "~~/shared/vault";
import type { GearGlyph } from "~~/shared/gearGlyph";
import { formatWeight, itemDisplayName } from "~~/shared/weights";
import { VAULT_KIT_QTY_MAX, kitPartRefs } from "~~/shared/vaultKit";
import { strongVaultRows } from "~~/shared/vaultSearch";

// One kit on My Gear's Kits tab, in the section a kind uses on the Gear tab
// (VaultSection): its name as the heading, with the collapse chevron, and its items as
// rows of gear beneath — the same VaultGearRow, so an item reads exactly as it does on
// its own (Ryan: "can kits use this kind of structure and visual formatting?"). Then
// "Add an item", the way a list's folder ends.
//
// Everything about a kit is edited here: the heading is its name, and each item's count
// and removal sit where a row's edit and remove would. Done with a kit, its bin puts it
// away and its items stay the pieces they are (there is no "back to a single piece":
// rare, and the bin covers it). Each change sends the WHOLE set, which is what the vault's kit op
// takes. A kit keeps at least one item: emptying one would turn it back into a piece
// at the weight it showed, which is not what taking the last item out means.
//
// A new kit not saved yet (New kit) is the one `kit` that isn't a kit: the same section
// with no items, its "Add an item" focused, and the first item saves it. Escape on that
// empty line gives up on it.
const props = defineProps<{
  kit: VaultEntry;
  /** every piece of your gear by id: an item's own row, and its owned count */
  gearById: ReadonlyMap<number, VaultEntry>;
  unit: Unit;
  /** a change to this kit is saving: its controls wait */
  busy?: boolean;
  /** offline, showing this device's copy: the kit reads, it doesn't change */
  readonly?: boolean;
}>();
const emit = defineEmits<{
  /** the kit's items as they should now be, and its own weight */
  kit: [parts: { id: number; qty: number }[], ownWeightMg: number];
  rename: [name: string];
  remove: [];
  /** a new kit given up on before an item went in */
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
// An item put away from My Gear can always come out, so long as it isn't the last item
// of any kind: the kit op reads an empty set as "no longer a kit".
const canDrop = (p: VaultKitPart) => parts.value.length > 1 && (!!p.removed || liveCount.value > 1);

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
// THE CHOICES FLOAT under the field, as a list's suggestions do under its add row
// (ItemInput), and for its reason: in the page's flow they pushed everything under the
// kit down and back with each letter typed, and read as part of the kit. So they are
// a listbox the field owns: up while the field has focus, one row lit (the one Enter
// takes, the first until an arrow moves it), on the same card, in the room the keyboard
// leaves (useSuggestPlacement), hung from the add row.
const addId = useId();
const addFocused = ref(false);
const active = ref(0);
watch(choices, () => (active.value = 0));
const menuOpen = computed(() => addFocused.value && choices.value.length > 0);
const addRow = useTemplateRef<HTMLElement>("addRow");
const { above, room } = useSuggestPlacement(() => addRow.value, () => menuOpen.value);
function onAddKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    // an input method confirming a composition, not a pick (ItemInput's rule too)
    if (e.isComposing) return;
    e.preventDefault();
    const g = choices.value[active.value] ?? choices.value[0];
    if (g) add(g);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const n = choices.value.length;
    if (!n) return;
    e.preventDefault();
    active.value = (active.value + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    nextTick(() => document.getElementById(`${addId}-${active.value}`)?.scrollIntoView({ block: "nearest" }));
  } else if (e.key === "Escape") {
    if (addQuery.value) addQuery.value = "";
    else if (!isKit.value) emit("cancel");
  }
}
watch(
  isKit,
  (kit) => {
    if (!kit) nextTick(() => addEl.value?.focus());
  },
  { immediate: true },
);
</script>

<template>
  <VaultSection class="kitsec" :label="name" :collapse-key="`kit-${kit.id}`" :list-label="`Items in ${name}`">
    <template #title>
      <input
        class="field folder__name"
        :value="kit.name"
        :readonly="readonly"
        :maxlength="VAULT_NAME_MAX"
        :aria-label="`Name of ${name}`"
        autocomplete="off"
        spellcheck="false"
        @change="commitName"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        @keydown.esc="revertName"
      />
    </template>
    <template #actions>
      <span class="t-num t-muted kitsec__total">{{ formatWeight(kit.weightMg, unit) }}</span>
      <!-- the site's tooltip on every icon-only button here, as on a list row: the verb
           shown, the whole name on aria-label -->
      <Tooltip v-if="isKit && !readonly" text="Remove">
        <button
          type="button"
          class="btn btn--icon btn--ghost foreground-quiet"
          :aria-label="`Remove ${name} from My Gear`"
          @click="emit('remove')"
        >
          <SvgIcon :icon="IconTrashCan" aria-hidden="true" />
        </button>
      </Tooltip>
    </template>

    <template #default>
      <template v-for="{ part, entry } in rows" :key="part.id">
        <VaultGearRow
          v-if="entry"
          :entry="entry"
          :unit="unit"
          :readonly="readonly"
          @edit="emit('edit', entry)"
          @icon="(g: GearGlyph | null) => emit('icon', entry, g)"
          @unit="(u: Unit) => emit('unit', entry, u)"
        >
          <template #lead>
            <!-- how many the kit holds: held out of sight, not dropped, on a row
                 that can't change, so the columns stay put down the kit -->
            <span v-if="counts" class="kitsec__step" :class="{ 'is-idle': part.qty <= 1 && partMax(part.id) <= 1 }">
              <Tooltip text="One fewer">
                <button
                  type="button"
                  class="btn btn--icon btn--ghost foreground-quiet"
                  :disabled="busy || part.qty <= 1"
                  :aria-label="`One fewer ${part.name} in ${name}`"
                  @click="step(part.id, -1)"
                >
                  <SvgIcon :icon="IconMinusMedium" size="sm" aria-hidden="true" />
                </button>
              </Tooltip>
              <span class="t-num kitsec__count" :aria-label="`${part.qty} in the kit`">{{ part.qty }}</span>
              <!-- at the cap it says why: a kit holds no more than you own -->
              <Tooltip :text="part.qty >= ownedOf(part.id) ? `You own ${ownedOf(part.id)}. To add another, edit this piece and raise “Number owned”.` : 'One more'">
                <button
                  type="button"
                  class="btn btn--icon btn--ghost foreground-quiet"
                  :disabled="busy || part.qty >= partMax(part.id)"
                  :aria-label="`One more ${part.name} in ${name}`"
                  @click="step(part.id, 1)"
                >
                  <SvgIcon :icon="IconPlusMedium" size="sm" aria-hidden="true" />
                </button>
              </Tooltip>
            </span>
          </template>
          <template #remove>
            <Tooltip :text="canDrop(part) ? 'Take out of kit' : 'A kit holds at least one item'">
              <button
                type="button"
                class="btn btn--icon btn--ghost foreground-quiet"
                :disabled="busy || !canDrop(part)"
                :aria-label="`Take ${part.name} out of ${name}`"
                @click="drop(part.id)"
              >
                <SvgIcon :icon="IconCircleMinus" aria-hidden="true" />
              </button>
            </Tooltip>
          </template>
        </VaultGearRow>
        <!-- put away from My Gear: listed by name, it stops counting and can only come out -->
        <li v-else class="kitsec__line kitsec__line--gone">
          <span class="kitsec__name t-clip">{{ itemDisplayName(part.brand, part.name, part.variant) }} <span class="kitsec__gone">· removed</span></span>
          <Tooltip v-if="!readonly" :text="canDrop(part) ? 'Take out of kit' : 'A kit holds at least one item'">
            <button
              type="button"
              class="btn btn--icon btn--ghost foreground-quiet"
              :disabled="busy || !canDrop(part)"
              :aria-label="`Take ${part.name} out of ${name}`"
              @click="drop(part.id)"
            >
              <SvgIcon :icon="IconCircleMinus" aria-hidden="true" />
            </button>
          </Tooltip>
        </li>
      </template>
      <!-- a weight of the kit's own (a group saved off a list whose heading had one) -->
      <li v-if="kit.ownWeightMg" class="kitsec__line">
        <span class="kitsec__name">The kit’s own weight</span>
        <span class="t-num">{{ formatWeight(kit.ownWeightMg, unit) }}</span>
        <Tooltip v-if="!readonly" text="Remove its own weight">
          <button
            type="button"
            class="btn btn--icon btn--ghost foreground-quiet"
            :disabled="busy"
            :aria-label="`Remove ${name}’s own weight`"
            @click="send(kitPartRefs(parts), 0)"
          >
            <SvgIcon :icon="IconCircleMinus" aria-hidden="true" />
          </button>
        </Tooltip>
      </li>
    </template>

    <template v-if="!readonly" #after>
      <div ref="addRow" class="kitsec__add">
        <input
          ref="addEl"
          v-model="addQuery"
          class="field"
          :data-kit-add="kit.id"
          placeholder="Add an item"
          :aria-label="`Add an item from your gear to ${name}`"
          role="combobox"
          aria-autocomplete="list"
          :aria-expanded="menuOpen"
          :aria-controls="`${addId}-list`"
          :aria-activedescendant="menuOpen ? `${addId}-${active}` : undefined"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          @keydown="onAddKey"
          @focus="addFocused = true"
          @blur="addFocused = false"
        />
        <!-- mousedown.prevent on a row, as the list's menu has it: a press here is a
             press inside the control, and letting it take focus would close the menu
             under the pointer before the click landed -->
        <Transition name="menu">
          <div
            v-if="menuOpen"
            class="popover ac__menu kitsec__menu"
            :class="{ 'ac__menu--above': above }"
            :style="room != null ? { '--ac-room': `${room}px` } : undefined"
          >
            <ul :id="`${addId}-list`" class="ac__list" role="listbox" aria-label="Your gear">
              <li
                v-for="(g, i) in choices"
                :id="`${addId}-${i}`"
                :key="g.id"
                class="ac__opt kitsec__choice"
                :class="{ 'is-active': i === active }"
                role="option"
                :aria-selected="i === active"
                @mousedown.prevent="add(g)"
                @mouseenter="active = i"
              >
                <span class="t-clip">{{ itemDisplayName(g.brand, g.name, g.variant) }}</span>
                <span class="t-num t-muted">{{ formatWeight(g.weightMg, g.entryUnit ?? unit) }}</span>
              </li>
            </ul>
          </div>
        </Transition>
        <p v-if="addQuery.trim() && !choices.length" class="t-muted kitsec__none">None of your gear matches. Add it to My Gear first.</p>
      </div>
    </template>
  </VaultSection>
</template>

<style scoped>
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
   rows' rhythm and hairline come from the list (.folder__items), and its name starts
   under the rows' names */
.kitsec__line {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding-inline-start: var(--gear-type-indent);
  color: var(--foreground-secondary);
}
.kitsec__name {
  flex: 1;
}
.kitsec__line--gone {
  color: var(--foreground-tertiary);
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
  color: var(--foreground-primary);
}
/* "Add an item", under the items' names, as a list folder's add row sits. The anchor
   of the choices that float under it. */
.kitsec__add {
  position: relative;
  padding: var(--space-2) 0 0 var(--gear-type-indent);
  border-top: 1px solid var(--border-primary);
}
.kitsec__none {
  margin: var(--space-1) 0 0;
}
/* THE CHOICES, on the card a list's suggestions come on (.ac__menu, .ac__list and
   .ac__opt in atoms/controls.scss): the shared .popover surface, hung from the section's
   left edge as that one hangs from its row's. They were a bordered box in the page's
   flow with a hairline between rows, a second look for the same act two tabs apart. The
   folder's collapse clip lets any .popover out (atoms/folder.scss), so the last kit's
   card isn't cut off at the section's foot. As wide as the list's, inside the section. */
.kitsec__menu {
  width: min(40rem, 100%);
}
.kitsec__choice {
  color: var(--foreground-primary);
}
</style>
