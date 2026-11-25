<script setup lang="ts">
import { IconBrackets1, IconFileArrowLeftIn, IconFileExcel, IconSquareChecklist } from "~/icons/central";
import { SvgIcon } from "~/utils/icon";
import { SITE_LINKS } from "~/utils/siteLinks";
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
//
// Help, About and Legal close it, as they close the editor's menu, and for the editor's
// reason: this page has no footer (gear.vue marks the body `bare`). It had the site's,
// from when it was a site page; it is laid out as the editor is now (Your packs, the
// tabs, this ⋯), and a footer under it was the one part still saying "website", ruling
// a line under an empty page (Ryan: "why is this footer here vs in the ⋯ menu?").
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
          <SvgIcon :icon="IconSquareChecklist" aria-hidden="true" />
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
          <SvgIcon :icon="IconFileArrowLeftIn" aria-hidden="true" />
          Import gear…
        </button>
        <!-- the same two words the editor's and the read views' export rows use, so
             one action keeps one name wherever you meet it -->
        <template v-if="canExport">
          <button type="button" data-row role="menuitem" class="menu__item" @click="close(); emit('pick', 'csv')">
            <SvgIcon :icon="IconFileExcel" aria-hidden="true" />
            Download CSV
          </button>
          <button type="button" data-row role="menuitem" class="menu__item" @click="close(); emit('pick', 'json')">
            <SvgIcon :icon="IconBrackets1" aria-hidden="true" />
            Download JSON
          </button>
        </template>
      </li>
      <!-- the site foot, ruled off from this page's own rows: for everyone, signed in or
           not, since it is now the only way from here to these three -->
      <li role="none" class="menu__foot">
        <NuxtLink v-for="l in SITE_LINKS" :key="l.to" :to="l.to" data-row role="menuitem" class="menu__item" @click="close()">
          <SvgIcon :icon="l.icon" aria-hidden="true" />
          {{ l.label }}
        </NuxtLink>
      </li>
    </template>
  </KebabMenu>
</template>
