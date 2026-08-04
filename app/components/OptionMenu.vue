<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { CheckIcon } from "@hugeicons/core-free-icons";

// Pick one of a few things — the app's answer to a native <select>.
//
// There were five of those, all built the same way: a transparent native select laid
// over some custom markup. The behaviour came free, but the list it opened was the
// operating system's, which made it the one surface in the app that didn't look like
// the app. Two sort pickers (the editor's folder headers and the vault's) and three
// unit pickers (the editor total, the vault total, and each item row).
//
// What differs between them is only the TRIGGER — a glyph, a display-size figure, a
// caption-sized unit. So the trigger is a slot and everything else lives here: the
// popover, the travelling plate, the check on the current row, outside-tap and Escape.
// The button itself stays in this component so aria-haspopup/expanded can't drift.
type Option = { key: string; label: string; icon?: unknown };

const props = defineProps<{
  options: readonly Option[];
  /** the active key — its row carries the check, and it's handed to the trigger slot */
  current: string;
  /** the control's accessible name, e.g. "Sort items in Shelter", "Weight unit" */
  label: string;
  /** styling hook for the trigger button; the caller owns how its trigger looks */
  triggerClass?: string;
  title?: string;
}>();
const emit = defineEmits<{ pick: [key: string] }>();

const open = ref(false);
const rootRef = useTemplateRef<HTMLElement>("rootRef");
// the travelling wash shared with every other menu (useMenuPlate)
const { plateRef, listRef, placing, on: plateOn } = useMenuPlate();

onClickOutside(rootRef, () => (open.value = false));
useWindowEvent("keydown", (e) => {
  if (e.key === "Escape" && open.value) open.value = false;
});

const active = computed(() => props.options.find((o) => o.key === props.current) ?? props.options[0]);
function pick(key: string) {
  open.value = false;
  emit("pick", key);
}
</script>

<template>
  <div ref="rootRef" class="menu optmenu">
    <button
      type="button"
      class="optmenu__btn"
      :class="triggerClass"
      :title="title"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      <!-- the caller draws its own trigger; `active` is the option it should show and
           `open` lets it turn a chevron over -->
      <slot name="trigger" :active="active" :open="open" />
    </button>
    <Transition name="menu">
      <ul
        v-if="open"
        ref="listRef"
        class="popover menu__list optmenu__list"
        role="menu"
        :aria-label="label"
        v-on="plateOn"
      >
        <li role="none" aria-hidden="true">
          <span ref="plateRef" class="menu__plate" :class="{ 'is-placing': placing }" />
        </li>
        <li v-for="o in options" :key="o.key" role="none">
          <button
            type="button"
            data-row
            role="menuitem"
            class="menu__item optmenu__item"
            :aria-current="o.key === current ? 'true' : undefined"
            @click="pick(o.key)"
          >
            <!-- :icon, NOT <component :is>. A hugeicons icon is PATH DATA rather than
                 a component, so :is would try to render an array and fail. -->
            <HugeiconsIcon v-if="o.icon" :icon="o.icon" class="optmenu__icon" :size="14" :stroke-width="2" aria-hidden="true" />
            <span class="optmenu__label">{{ o.label }}</span>
            <HugeiconsIcon
              v-if="o.key === current"
              :icon="CheckIcon"
              class="optmenu__check"
              :size="14"
              :stroke-width="2"
              aria-hidden="true"
            />
          </button>
        </li>
      </ul>
    </Transition>
  </div>
</template>

<style scoped>
.optmenu {
  display: inline-flex;
  align-items: center;
}
/* The trigger is bare by default — no .btn chrome — because most of these wrap
   something that is already the affordance (a display figure, a caption, a glyph).
   Callers add .btn--icon and friends through `triggerClass` when they want the box.
   Colour inherits so a caller can light its glyph for a non-default value, which is
   how a sorted folder reads as sorted even collapsed. */
.optmenu__btn {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.optmenu__list {
  min-width: 7rem;
}
/* icon · label · check, with the label taking the slack so the check lands on the
   trailing edge — the row shape ListMenu uses */
.optmenu__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
/* flex: none on BOTH glyphs. Without it the leading icon is the only shrinkable child
   in the row — the label grows and the check is fixed — so on the current row, the one
   row carrying all three, it collapsed to zero width and pulled that label 14px out of
   line with every other. */
.optmenu__icon {
  flex: none;
}
.optmenu__label {
  flex: 1 1 auto;
  text-align: start;
}
.optmenu__check {
  flex: none;
  color: var(--ink-3);
}
</style>
