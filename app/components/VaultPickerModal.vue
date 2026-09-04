<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { CheckmarkSquare02Icon, SquareIcon } from "@hugeicons/core-free-icons";
import type { Unit } from "~~/shared/types";
import type { VaultCapture } from "~~/shared/vault";
import { formatWeightAuto, itemDisplayName, unitSystem } from "~~/shared/weights";

// "Which of these is yours?" — shown when you answer Add on a list you didn't
// start. The only lists that ever ask are shared ones, and on a trip planned
// together some of the gear belongs to the other person; taking the list
// wholesale would put their stove in your vault, and refusing outright would
// lose your own tent. So: the same rows capture would have taken, ticked by
// default, and untick what isn't yours.
//
// What you untick is remembered for THIS list (useVault's exclusions), so later
// edits don't quietly re-offer it.
// `unit` is the open list's own display unit — the weights here should read the
// way they read on the page behind the dialog, not in whatever the vault page
// happens to be set to.
const { caps, unit } = defineProps<{ caps: VaultCapture[] | null; unit?: Unit }>();
const emit = defineEmits<{ confirm: [string[]]; cancel: [] }>();

const system = computed(() => unitSystem(unit));

// Ticked by default: you did just say yes. The chooser is here to let you take
// something OUT, which is the rarer and more deliberate act.
const keep = ref(new Set<string>());
watch(
  () => caps,
  (rows) => (keep.value = new Set((rows ?? []).map((c) => c.normKey))),
  { immediate: true },
);

function toggle(normKey: string) {
  const next = new Set(keep.value);
  if (!next.delete(normKey)) next.add(normKey);
  keep.value = next; // a NEW set — mutating in place wouldn't retrigger the computeds
}

const allOn = computed(() => !!caps?.length && keep.value.size === caps.length);
function toggleAll() {
  keep.value = allOn.value ? new Set() : new Set((caps ?? []).map((c) => c.normKey));
}

// Grouped by the list folder each row came from, because that's the shape the
// person is looking at on the page behind the dialog — scanning "is this mine?"
// down a flat list of forty rows is much harder than down the folder you packed.
const groups = computed(() => {
  const by = new Map<string, VaultCapture[]>();
  for (const c of caps ?? []) {
    const key = c.folder ?? "";
    const list = by.get(key);
    if (list) list.push(c);
    else by.set(key, [c]);
  }
  return [...by.entries()].map(([folder, rows]) => ({ folder, rows }));
});
</script>

<template>
  <BaseModal :open="!!caps" label="Choose which gear is yours" @close="emit('cancel')">
    <template v-if="caps">
      <h2 class="t-label">Add to My Gear</h2>
      <p class="t-sm t-muted dlg__lede">
        You didn’t start this list, so some of it may not be your gear. Untick anything that
        isn’t — you can change it later on the My Gear page.
      </p>

      <div class="vpick__bar">
        <button type="button" class="btn btn--quiet" @click="toggleAll">
          {{ allOn ? "Untick all" : "Tick all" }}
        </button>
        <span class="t-sm t-muted">{{ keep.size }} of {{ caps.length }}</span>
      </div>

      <div class="vpick__scroll">
        <div v-for="g in groups" :key="g.folder" class="vpick__group">
          <p v-if="g.folder" class="t-sm t-muted vpick__folder">{{ g.folder }}</p>
          <label v-for="c in g.rows" :key="c.normKey" class="vpick__row">
            <!-- the site's checkbox: a real <input> laid invisibly over the icon
                 pair, so behaviour and focus stay native while the visuals are the
                 same Square/SquareCheck the packing rows use. A bare checkbox here
                 renders as the browser's blue, which is the one bit of chrome this
                 design never shows. -->
            <span class="check">
              <input
                type="checkbox"
                class="check__box"
                :checked="keep.has(c.normKey)"
                :aria-label="`Add ${itemDisplayName(c.brand, c.name, c.variant)} to My Gear`"
                @change="toggle(c.normKey)"
              />
              <HugeiconsIcon :icon="SquareIcon" class="check__icon check__icon--empty" :size="20" :stroke-width="1.33" absolute-stroke-width aria-hidden="true" />
              <HugeiconsIcon :icon="CheckmarkSquare02Icon" class="check__icon check__icon--check" :size="20" :stroke-width="1.33" absolute-stroke-width aria-hidden="true" />
            </span>
            <span class="vpick__name">{{ itemDisplayName(c.brand, c.name, c.variant) }}</span>
            <span class="t-sm t-muted t-num vpick__weight">{{
              formatWeightAuto(c.weightMg, { system })
            }}</span>
          </label>
        </div>
      </div>

      <div class="dlg__actions">
        <button class="btn btn--ghost" @click="emit('cancel')">Cancel</button>
        <button class="btn btn--primary" :disabled="!keep.size" @click="emit('confirm', [...keep])">
          Add {{ keep.size }}
        </button>
      </div>
    </template>
  </BaseModal>
</template>

<style scoped>
/* overlay + shell + action row come from atoms/dialog.scss; what's here is the
   list itself */
.vpick__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
/* the list is the one part that can outgrow the dialog — a forty-item list has to
   scroll INSIDE it, not push the actions off the bottom of the screen */
.vpick__scroll {
  max-height: min(48vh, 26rem);
  overflow-y: auto;
  overscroll-behavior: contain;
  margin-inline: calc(-1 * var(--space-2));
  padding-inline: var(--space-2);
}
.vpick__group + .vpick__group {
  margin-top: var(--space-3);
}
.vpick__folder {
  margin-bottom: var(--space-1);
}
.vpick__row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: baseline;
  gap: var(--space-2);
  padding-block: var(--space-2);
  cursor: pointer;
}
.vpick__row + .vpick__row {
  border-top: 1px solid var(--line);
}
/* the row's hover darkens its .check atom's box, via the inherited ink */
.vpick__row:hover .check__icon {
  color: var(--ink);
}
.vpick__name {
  min-width: 0;
  overflow-wrap: anywhere;
}
.vpick__weight {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
