<script setup lang="ts">
// My Gear's ⋯ actions menu — the same quiet kebab the editor and the read views
// carry, in the one place that didn't have one.
//
// A COMPONENT rather than markup inside gear.vue, matching ListMenu and
// ReadonlyMenu, and only its ROWS: the popover, the travelling plate and the dismiss
// rules are KebabMenu's, so they can't behave differently here from any other menu
// on the site, and the page is long enough already. It holds no logic of its own on
// purpose — the actions are the page's, and it only says which one you picked.
//
// No Export disclosure, unlike the other two. Theirs folds four formats away from
// the items you came for; getting gear in and out is all this menu does, and a fold
// around three rows would be a door in front of a door.
const {
  /** Whether there is gear to download. Import stands alone on an empty vault —
   *  restoring a backup onto a new machine is the case that matters most, and it is
   *  exactly the case with nothing to export. */
  canExport = false,
} = defineProps<{ canExport?: boolean }>();
// `open` warms the exporter chunk, so pressing a row doesn't wait on a fetch
const emit = defineEmits<{ pick: [action: string]; open: [] }>();
</script>

<template>
  <KebabMenu @open="emit('open')">
    <template #default="{ close }">
      <!-- Import first: it is the row that works on an empty vault, and on a
           full one it is still the rarer, more deliberate act — the downloads
           below it are the ones you reach for without thinking. -->
      <li role="none">
        <button type="button" data-row role="menuitem" class="menu__item" @click="close(); emit('pick', 'import')">Import gear…</button>
      </li>
      <!-- the same two words the editor's and the read views' export rows use, so
           one action keeps one name wherever you meet it -->
      <template v-if="canExport">
        <li role="none">
          <button type="button" data-row role="menuitem" class="menu__item" @click="close(); emit('pick', 'csv')">Download CSV</button>
        </li>
        <li role="none">
          <button type="button" data-row role="menuitem" class="menu__item" @click="close(); emit('pick', 'json')">Download JSON</button>
        </li>
      </template>
    </template>
  </KebabMenu>
</template>
