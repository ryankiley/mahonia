<script setup lang="ts">
import { IconArrowBoxLeft, IconCloudOff, IconUser, IconUserKey, IconSafeSimple } from "~/icons/central";
import { SvgIcon } from "~/utils/icon";
// SafeSimple is the editor toolbar's own My Gear glyph — the same thing named the same
// way, so the row and the button can't read as two different destinations.

// The card AccountMenu's trigger opens: its own file so that it loads on the first
// open and not with every page, as EditorMenu does for the ⋯ menu. AccountMenu decides
// what the trigger is and what offline means; this draws the rows. Mounted Lazy on the
// first open, already open, so the Transition carries `appear` (EditorMenu says why).
const props = defineProps<{
  open: boolean;
  /** signed in, as the hint cookie presumes (AccountMenu) */
  known: boolean;
  offline: boolean;
  /** offline with a connection: only Mahonia can't be reached */
  unreachable: boolean;
  offlineHead: string;
  /** the row to /gear earns its place (AccountMenu's showGear) */
  showGear: boolean;
}>();
const emit = defineEmits<{ close: []; account: []; signOut: [] }>();

// offline is no connection OR a sync that can't reach the server (useOffline), so this
// is the connection itself: there whenever we aren't offline, or are only unreachable.
const online = computed(() => !props.offline || props.unreachable);

const sync = useSyncOffline();
/** what the card says under its heading */
const offlineLine = computed(() => {
  const saved = sync.value === "saved" ? "This list is saved on this device." : "";
  const next = props.known
    ? saved && "It syncs when you’re back online."
    : !props.unreachable && "Sign in when you’re back online.";
  return [saved, next].filter(Boolean).join(" ");
});

function account() {
  emit("close");
  emit("account");
}
</script>

<template>
  <Transition name="menu" appear>
    <MenuList v-if="open" :aria-label="offline ? offlineHead : 'Your account'">
      <!-- what the struck cloud means, said in full where it was pressed. Not a row:
           nothing here is pressed, so it takes no hover. The shared
           menu callout, the Export tab's card (Ryan, 2026-11-25): bare words above
           the account's rows read as a heading for them. -->
      <li v-if="offline" role="none" class="menu__callout acct__offline">
        <SvgIcon :icon="IconCloudOff" aria-hidden="true" />
        <div class="menu__callout-body">
          <p class="menu__callout-title acct__offhead">{{ offlineHead }}</p>
          <p v-if="offlineLine" class="menu__callout-text acct__offline-line">{{ offlineLine }}</p>
        </div>
      </li>
      <li v-if="!known && unreachable" role="none">
        <button type="button" role="menuitem" class="menu__item" @click="account">
          <SvgIcon :icon="IconUserKey" aria-hidden="true" />
          Sign in
        </button>
      </li>
      <li v-if="known && showGear" role="none">
        <NuxtLink to="/gear" role="menuitem" class="menu__item" @click="emit('close')">
          <SvgIcon :icon="IconSafeSimple" aria-hidden="true" />
          My Gear
        </NuxtLink>
      </li>
      <!-- The account's own two rows need the server, so with no connection they are
           not here: "Your account" opened a dialog that could only say it opens once
           you're back online, and "Sign out" could not reach the server to end the
           session (it signed the page out and left the cookie). An inert row is
           absent, not disabled. Offline the card is then one thing, signed in or out:
           what the cloud means. `online`, not `offline`: when it is only Mahonia that
           can't be reached, either may well work, and they stay. -->
      <li v-if="known && online" role="none">
        <button type="button" role="menuitem" class="menu__item" @click="account">
          <SvgIcon :icon="IconUser" aria-hidden="true" />
          Your account
        </button>
      </li>
      <li v-if="known && online" role="none">
        <button type="button" role="menuitem" class="menu__item" @click="emit('signOut')">
          <SvgIcon :icon="IconArrowBoxLeft" aria-hidden="true" />
          Sign out
        </button>
      </li>
    </MenuList>
  </Transition>
</template>

<style scoped>
/* The offline card's words are the shared .menu__callout (atoms/controls.scss). What is
   this card's own is a measure: a card is as wide as its longest row, and with no rows,
   or two short ones, that is nothing for a sentence to go by. */
.acct__offline {
  width: 15rem;
  max-width: calc(100vw - var(--space-6));
}
/* Alone in the card, which is every offline card with no connection, it wears no mark
   either: the cloud that opened it is right above, and with no rows there is no glyph
   column for a second one to sit in. */
.acct__offline:last-child > svg {
  display: none;
}
</style>
