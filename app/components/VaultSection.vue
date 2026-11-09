<script setup lang="ts">
// One section of My Gear: a kind on the Gear tab, a kit on the Kits tab. The list's
// folder, class for class (the header grid, the collapse chevron and the 1fr↔0fr body
// are atoms/folder.scss), around rows of VaultGearRow.
//
// ONE component for both because two hand-kept copies drifted (2026-11-08): the kind's
// heading was an h2 on the reset's tight leading and the kit's an input on the body's,
// so every row on Kits sat 5px lower than the same row on Gear and the first rows
// jumped when you switched tabs; and only the kind overrode the folder atom's
// five-column item grid, so on a wide screen the two headers weren't laid out alike.
//
// A kind's heading is its name (`label`); a kit's is the field that renames it, passed
// in #title. No label, no header: a chosen order or a search is one unheaded list.
// #actions sits opposite the name (a kit's weight and bin); #after follows the list,
// inside the collapsing body (a kit's "Add an item").
//
// Collapse is the list folder's own (usePersistedCollapse, as FolderSection uses it):
// remembered per kind or kit on this device under `collapseKey`, never sent to the
// server, since it's how you're looking at your gear rather than a fact about it.
//
// The default slot is the rows, handed `overlay`: a row's menus are absolutely
// positioned and the body clips for the collapse animation, so a menu opened on the
// last row was guillotined. The section counts the open ones and lifts the clip while
// any is, as FolderSection does for the list's rows.
const props = defineProps<{
  label?: string;
  /** the remembered collapse's key: a kind's, or `kit-<id>` */
  collapseKey?: string;
  /** the list's accessible name, when the heading alone doesn't give it */
  listLabel?: string;
}>();
const { collapsed, toggle } = usePersistedCollapse("gear.vkind.").useFor(() => props.collapseKey ?? "");

const overlays = ref(0);
const overlay = (open: boolean) => (overlays.value = Math.max(0, overlays.value + (open ? 1 : -1)));
</script>

<template>
  <section class="folder vsec" :data-collapsed="label && collapsed ? true : null">
    <header v-if="label" class="folder__head">
      <div class="folder__title">
        <!-- the heading borrows the name field's type so a kind's name sits exactly
             where a kit's (and a list folder's) editable one does -->
        <slot name="title"><h2 class="field folder__name vsec__kind">{{ label }}</h2></slot>
        <NestChevron folder :collapsed="collapsed" :label="label" @toggle="toggle" />
      </div>
      <div v-if="$slots.actions" class="folder__actions"><slot name="actions" /></div>
    </header>

    <div class="folder__body">
      <div class="folder__bodyinner" :class="{ 'is-overlay-open': overlays > 0 }">
        <ul class="vsec__list folder__items" :aria-label="listLabel">
          <slot :overlay="overlay" />
        </ul>
        <slot name="after" />
      </div>
    </div>
  </section>
</template>

<style scoped>
/* the kinds' spacing, between kits too */
.vsec + .vsec {
  margin-top: var(--space-6);
}
/* Name, then whatever sits opposite it, at every width: the folder atom's desktop
   header is the list editor's five-column ITEM grid, which these rows (VaultGearRow)
   don't use. */
.folder__head {
  --head-cols: 1fr auto;
  gap: var(--space-4);
}
.folder__title {
  grid-column: 1;
}
.folder__actions {
  grid-column: 2;
}
/* a heading, not a field: the field's type and its LINE (the reset gives an h2 the
   tight heading leading, which is what stood it 5px shorter than a kit's name) */
.vsec__kind {
  margin: 0;
  color: var(--ink);
  line-height: var(--leading-normal);
  cursor: default;
}
/* the rows are VaultGearRow's own; the list stacks them, and their rhythm and the
   hairlines between are the list folder's (.folder__items, atoms/folder.scss) for every
   line, a kit's extra lines included */
.vsec__list {
  display: flex;
  flex-direction: column;
  list-style: none;
}
</style>
