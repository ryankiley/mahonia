<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
// UserRoundKey is a lucide name with no hugeicons twin; UserLock01 is the nearest
// person-plus-credentials glyph.
// SafeBox is the editor toolbar's own My Gear glyph — the same thing named the same
// way, so the row and the button can't read as two different destinations.
import { Logout01Icon, SafeBoxIcon, UserCircleIcon, UserIcon, UserLock01Icon } from "@hugeicons/core-free-icons";

// The account affordance in the top bar. Two shapes, because signed in and signed
// out are different jobs:
//
//   signed out — a plain "Sign in" link. One destination, so a menu would be a
//                dropdown with a single item in it.
//   signed in  — a menu, because there is more than one thing you might want and
//                none of them deserves the bar's limited room. (In the editor it's
//                two: the bar has its own My Gear button — see `hasGearButton`.)
//
// Deliberately NOT an avatar. An account stores an optional display name and an
// email; there is no photo and never will be, so an avatar renders as a circle
// with a "?" for most people, and it would signal a profile product this isn't.
//
// COSTS THE SIGNED-OUT NOTHING. The state comes from the readable hint cookie, not
// a session lookup: /e is prerendered and CDN-served with no function invocation,
// and the overwhelming majority of visitors have no account. Reading a cookie that
// isn't there is free; asking the server would put a round-trip on first paint to
// be told "no".
// `compact` is for the EDITOR's toolbar, which is icon-only: there, the signed-out
// shape has to be an icon too or it lands as the one word in a row of glyphs. The
// site bar is a text bar and keeps the plain link.
//
// `hasGearButton` says the bar around this menu ALREADY carries its own My Gear
// control, so the menu must not repeat it. Only the editor does — its safebox glyph
// sits immediately left of this one, and the menu listed "My Gear" directly under
// it, which is the same words twice in adjacent controls. NOT folded into `compact`,
// though the editor is the only caller passing either: the read views are compact
// too and have no gear control of their own, so on that flag they'd have lost the
// only route they have to /gear.
const { compact = false, hasGearButton = false } = defineProps<{ compact?: boolean; hasGearButton?: boolean }>();

const { signedIn, hasSessionHint, signOut } = useSession();
const route = useRoute();

// The hint alone decides the shape — it carries no capability, and being wrong
// costs one 401 on a page the person asked for anyway. Waiting for the session to
// resolve would make the control change under the cursor on every load.
const known = ref(false);
onMounted(() => (known.value = hasSessionHint() || signedIn.value));
watch(signedIn, (yes) => (known.value = yes || hasSessionHint()));

const open = ref(false);
// the travelling wash shared with the other menus (see useMenuPlate)
const { plateRef, listRef, on: plateOn } = useMenuPlate();
const menuRef = useTemplateRef<HTMLElement>("menuRef");
// same close behaviour as the editor kebab and ReadonlyMenu: the action itself, an
// outside tap, a scroll gesture on mobile, or Escape
useMenuDismiss(open, menuRef);

async function onSignOut() {
  open.value = false;
  await signOut(); // drops the per-account memos itself — see useSession
  await navigateTo("/e");
}

// Never link to the page you're already on — it reads as an action and does
// nothing. Applies to both shapes.
const onAccount = computed(() => route.path === "/account");
const onVault = computed(() => route.path === "/gear");
// The row earns its place only where this menu is the way to /gear: not on /gear
// itself, and not in a bar that already has the button.
const showGear = computed(() => !onVault.value && !hasGearButton);

// The account opens OVER the page now, so there's nowhere to come back from and
// nothing to remember. useReturnTo still earns its keep for the magic link, which
// leaves the browser entirely and returns in a new tab — see /auth/callback.
const { open: openAccount } = useAccountModal();
</script>

<template>
  <ClientOnly>
    <!-- signed out: one thing to do, so a single control and not a menu. Icon in the
         editor's glyph row, words in the site bar.
         BUTTONS, not links: this opens a dialog over the page, it doesn't go anywhere.
         (It was a NuxtLink to /account, and @click.prevent does NOT stop NuxtLink's own
         navigation — it opened the modal AND left the page.) The classes stay, since
         print.scss hides both shapes by name. -->
    <Tooltip v-if="!known && compact" text="Sign in" preferred-placement="bottom">
      <button
        v-show="!onAccount"
        type="button"
        class="btn btn--icon btn--ghost acct__signinbtn"
        aria-label="Sign in"
        @click="openAccount"
      >
        <HugeiconsIcon :icon="UserLock01Icon" :size="16" :stroke-width="2" />
      </button>
    </Tooltip>
    <button
      v-else-if="!known"
      v-show="!onAccount"
      type="button"
      class="btn btn--link acct__signin"
      @click="openAccount"
    >
      Sign in
    </button>

    <div v-else ref="menuRef" class="menu">
      <Tooltip text="Your account" preferred-placement="bottom" :disabled="open">
      <button
        type="button"
        class="btn btn--icon btn--ghost menu__btn"
        aria-label="Your account"
        aria-haspopup="true"
        :aria-expanded="open"
        @click="open = !open"
      >
        <!-- a person, not a key: the key said "credentials", which is what the
             SIGNED-OUT state now says with a login glyph. This slot means "you".
             Still not an avatar — an account here has a name and an email, never a
             photo, so a circle with initials would promise a profile that isn't. -->
        <HugeiconsIcon :icon="UserCircleIcon" :size="16" :stroke-width="2" />
      </button>
      </Tooltip>
      <Transition name="menu">
        <ul v-if="open" ref="listRef" class="popover menu__list" role="menu" aria-label="Your account" v-on="plateOn">
          <!-- the travelling wash (atoms/controls.scss + useMenuPlate). role="none"
               so a decorative element can't read as a menu item. -->
          <li role="none" aria-hidden="true">
            <span ref="plateRef" class="menu__plate" />
          </li>
          <li v-if="showGear" role="none">
            <NuxtLink to="/gear" data-row role="menuitem" class="menu__item" @click="open = false">
              <HugeiconsIcon :icon="SafeBoxIcon" :size="14" :stroke-width="2" aria-hidden="true" />
              My Gear
            </NuxtLink>
          </li>
          <li v-if="!onAccount" role="none">
            <button type="button" data-row role="menuitem" class="menu__item" @click="open = false; openAccount()">
              <HugeiconsIcon :icon="UserIcon" :size="14" :stroke-width="2" aria-hidden="true" />
              Your account
            </button>
          </li>
          <li role="none">
            <button type="button" data-row role="menuitem" class="menu__item" @click="onSignOut">
              <HugeiconsIcon :icon="Logout01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
              Sign out
            </button>
          </li>
        </ul>
      </Transition>
    </div>
  </ClientOnly>
</template>

<style scoped>
/* the .menu / .popover / .menu__item atoms are shared (atoms/controls.scss), so
   this opens and looks exactly like the editor kebab and the read views' menu */
.acct__signin {
  white-space: nowrap;
}
/* ONE GLYPH COLUMN down the menu — the same block the editor's ⋯ and a row's menu
   each carry, scoped the same way and for the same reason (a menu whose rows lay
   themselves out differently must not inherit it). flex, because .menu__item is
   display:block and a glyph beside a label needs a row; `flex: none` on the <svg>
   because it is otherwise the one shrinkable thing in an absolutely positioned,
   shrink-to-fit box, and a long enough label collapses it to a sliver. */
.menu__list .menu__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.menu__list .menu__item > svg {
  flex: none;
}
</style>
