<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Csv01Icon, FileImportIcon, TaskAdd01Icon, ThirdBracketIcon } from "@hugeicons/core-free-icons";
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
//
// "Create a list" leads it. It was a word in the bar beside this menu, and on a phone
// the bar ran brand, page name, that word, the account glyph and ⋯ edge to edge with
// no air; the bar now holds the page's name and two glyphs at every width.
const {
  /** Signed in, with gear to import into. Signed out the menu is only the way to a
   *  new list, which needs no account. */
  signedIn = false,
  /** Whether there is gear to download. Import stands alone on an empty vault —
   *  restoring a backup onto a new machine is the case that matters most, and it is
   *  exactly the case with nothing to export. */
  canExport = false,
} = defineProps<{ signedIn?: boolean; canExport?: boolean }>();
// `open` warms the exporter chunk, so pressing a row doesn't wait on a fetch
const emit = defineEmits<{ pick: [action: string]; open: [] }>();
</script>

<template>
  <KebabMenu @open="emit('open')">
    <template #default="{ close }">
      <!-- the way out to a blank list: a checklist with a plus, the one glyph here that
           isn't about this page's gear -->
      <li role="none">
        <NuxtLink to="/e" data-row role="menuitem" class="menu__item" @click="close()">
          <HugeiconsIcon :icon="TaskAdd01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
          Create a list
        </NuxtLink>
      </li>
      <!-- getting gear in and out, ruled off from the row above: a different KIND of
           thing (the shared .menu__foot hairline). Import first: it is the row that
           works on an empty vault, and on a full one it is still the rarer, more
           deliberate act — the downloads below it are the ones you reach for without
           thinking. -->
      <li v-if="signedIn" role="none" class="menu__foot">
        <button type="button" data-row role="menuitem" class="menu__item" @click="close(); emit('pick', 'import')">
          <!-- the marks the editor's Import row and the list exports wear, so one act
               keeps one picture wherever you meet it -->
          <HugeiconsIcon :icon="FileImportIcon" :size="16" :stroke-width="2" aria-hidden="true" />
          Import gear…
        </button>
        <!-- the same two words the editor's and the read views' export rows use, so
             one action keeps one name wherever you meet it -->
        <template v-if="canExport">
          <button type="button" data-row role="menuitem" class="menu__item" @click="close(); emit('pick', 'csv')">
            <HugeiconsIcon :icon="Csv01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
            Download CSV
          </button>
          <button type="button" data-row role="menuitem" class="menu__item" @click="close(); emit('pick', 'json')">
            <HugeiconsIcon :icon="ThirdBracketIcon" :size="16" :stroke-width="2" aria-hidden="true" />
            Download JSON
          </button>
        </template>
      </li>
    </template>
  </KebabMenu>
</template>
