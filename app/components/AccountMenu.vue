<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
// UserRoundKey is a lucide name with no hugeicons twin; UserLock01 is the nearest
// person-plus-credentials glyph.
// SafeBox is the editor toolbar's own My Gear glyph — the same thing named the same
// way, so the row and the button can't read as two different destinations.
import { Logout01Icon, SafeBoxIcon, UserIcon, UserLock01Icon } from "@hugeicons/core-free-icons";

// The account affordance in the top bar. Two shapes, because signed in and signed
// out are different jobs:
//
//   signed out — a plain "Sign in" link. One destination, so a menu would be a
//                dropdown with a single item in it.
//   signed in  — a menu, because there is more than one thing you might want and
//                none of them deserves the bar's limited room. (In the editor it's
//                two: the bar has its own My Gear button — see `hasGearButton`.)
//
// The signed-in trigger is a grey disc lettered with your INITIAL (Ryan, 2026-09-12)
// — the first letter of the display name, or of the address while there is no name.
// It was a generic person glyph, held against an avatar on two counts: an account
// has no photo and never will, so a photo avatar would be a "?" for most people; and
// a face would promise a profile product this isn't. A letter answers the first —
// every account has an address, so there is always one and the disc is never blank
// or a "?" — and makes the second a feature: the one thing the bar can say about
// WHO is signed in, with what an account actually stores. Where the letter comes
// from, and how it is on the disc at first paint rather than a beat after
// /api/auth/me, is useAccountInitial.
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

const { presence, signOut } = useSession();
// the disc's letter — the session's own once it has resolved, this device's memo
// of it until then (so the disc mounts lettered, not empty)
const initial = useAccountInitial();
const route = useRoute();

// The hint alone decides the shape — it carries no capability, and being wrong
// costs one 401 on a page the person asked for anyway. Waiting for the session to
// resolve would make the control change under the cursor on every load. "Presumed"
// is that reading, defined once in useSession; set on mount rather than computed so
// the server-rendered (hint-less) shape hydrates without a mismatch.
const known = ref(false);
onMounted(() => (known.value = presence.value !== "signedOut"));
watch(presence, (p) => (known.value = p !== "signedOut"));

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
        <!-- your letter, not a key and not a person glyph: the key said
             "credentials", which is what the SIGNED-OUT state says with its login
             glyph; this slot means "you", and your own initial says that in a way a
             generic person can't. The button keeps the accessible name — to a screen
             reader the letter is decoration, and "R" would be a poor name for a menu.
             Empty for one beat only: before the first /api/auth/me on a browser that
             has never kept the memo (useAccountInitial). -->
        <span class="avatar" aria-hidden="true">{{ initial }}</span>
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

/* The disc wears --lit — the app's ONE plate meaning "this control is on", the same
   tone the selected mode tab and the classification chips sit on. So the bar says
   "signed in" the way the mode bar says "Gear": a state shown as a lit ground, not as
   a dark object. The first cut was a solid --ink-3 disc with a --paper letter; Ryan
   (2026-09-12): "circle is too dark, letter is too small, use the gray from the
   selected state of Gear". Hover steps the plate to --lit-hover, as the selected tab
   does; pointer-gated like every hover.
   THE LETTER IS A GLYPH, and weighs like one (Ryan, same day: "letter should feel more
   like the icon weight"). No colour of its own: it inherits the button's, so it rests
   at the same ink as the glyphs beside it — --ink-2 in the site bar, the editor's
   quieter --ink-3 — and darkens with them on hover, focus and open. Medium, not
   semibold: the icons are 2px strokes on a 24 grid drawn at 16px, ~1.33px of ink,
   which is a 14px medium stem; semibold read as a bold black mark in a row of thin
   grey lines.
   Sized in px like the glyphs beside it, NOT from the type scale: the bar's icons hold
   16px while --text-* grows past the 1920px anchor, and a letter on the scale would
   outgrow a disc that isn't. The letter is 0.64 of the disc — 14px at rest, the tab
   word's own --text-chrome size — so the two move together on touch. */
.avatar {
  --avatar: 22px;
  display: inline-grid;
  place-items: center;
  width: var(--avatar);
  height: var(--avatar);
  border-radius: var(--radius-pill);
  background: var(--lit);
  font-size: calc(var(--avatar) * 0.64);
  font-weight: 500;
  line-height: 1;
  text-transform: uppercase;
  transition: background var(--dur) var(--ease);
}
@media (hover: hover) and (pointer: fine) {
  .menu__btn:hover .avatar {
    background: var(--lit-hover);
  }
}
/* the glyphs grow 16 → 18 on touch (.btn--icon svg, controls.scss); the disc keeps
   the same ratio */
@media (pointer: coarse) {
  .avatar {
    --avatar: 24px;
  }
}
</style>
