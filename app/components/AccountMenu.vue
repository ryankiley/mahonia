<script setup lang="ts">
import { IconArrowBoxLeft, IconCloudOff, IconUser, IconUserKey, IconSafeSimple } from "~/icons/central";
import { SvgIcon } from "~/utils/icon";
// UserKey: a person with credentials, for the private account.
// Vault is the editor toolbar's own My Gear glyph — the same thing named the same
// way, so the row and the button can't read as two different destinations.

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
// is that reading, defined once in useSession. Read straight off it: the template is
// all inside <ClientOnly>, so nothing here is drawn on the server (which has no hint)
// for the browser's answer to mismatch.
const known = computed(() => presence.value !== "signedOut");

const open = ref(false);
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
// nothing. (The account had a page once and was hidden from its own menu there; it is
// a dialog now, opened over any page, so only My Gear has this to mind.)
const onVault = computed(() => route.path === "/gear");
// The row earns its place only where this menu is the way to /gear: not on /gear
// itself, and not in a bar that already has the button.
const showGear = computed(() => !onVault.value && !hasGearButton);

// The account opens OVER the page now, so a passkey sign-in has nowhere to come back
// from and this control remembers nothing. The emailed link is the exception: it
// leaves the browser and returns in a new tab, so the dialog remembers the page when
// the link is asked for (AccountView's sendLink, useReturnTo) and /auth/callback
// returns to it.
const { open: openAccount } = useAccountModal();

// OFFLINE, THE CONTROL SAYS SO. Its glyph becomes a cloud with a line through it, in
// both shapes, and pressing it opens a small card that says the rest: you're offline,
// the open list is saved on this device, and signing in will have to wait. For someone
// signed in the account's rows follow under it, as ever.
// This is where the bar says "offline" at all. The status line beside it used to
// ("Offline · saved on device"), and a phone cut that off mid-word.
const offline = useOffline();
const sync = useSyncOffline();
// TWO KINDS OF OFFLINE, and only one of them rules out signing in. With no network at
// all the card says so and offers nothing: the sign-in form could only say no. But the
// list's sync also says "offline" when the browser has a connection and the server did
// not answer for the list (a server error, a dead hotel wifi), and then signing in may
// well work. So that card says what is actually known, that Mahonia can't be reached,
// and keeps the way in.
const online = useOnline();
const unreachable = computed(() => offline.value && online.value);
const offlineHead = computed(() => (unreachable.value ? "Can’t reach Mahonia" : "You’re offline"));
/** what the card says under that */
const offlineLine = computed(() => {
  const saved = sync.value === "saved" ? "This list is saved on this device." : "";
  const next = known.value
    ? saved && "It syncs when you’re back online."
    : !unreachable.value && "Sign in when you’re back online.";
  return [saved, next].filter(Boolean).join(" ");
});
// the card belongs to being offline: back online, a signed-out control is a button again
watch(offline, (off) => {
  if (!off && !known.value) open.value = false;
});
</script>

<template>
  <ClientOnly>
    <!-- signed out: one thing to do, so a single control and not a menu. Icon in the
         editor's glyph row, words in the site bar.
         BUTTONS, not links: this opens a dialog over the page, it doesn't go anywhere.
         (It was a NuxtLink to /account, and @click.prevent does NOT stop NuxtLink's own
         navigation — it opened the modal AND left the page.) The classes stay, since
         print.scss hides both shapes by name. -->
    <Tooltip v-if="!known && !offline && compact" text="Sign in" preferred-placement="bottom">
      <button
        type="button"
        class="btn btn--icon btn--ghost acct__signinbtn"
        aria-label="Sign in"
        @click="openAccount"
      >
        <SvgIcon :icon="IconUserKey" />
      </button>
    </Tooltip>
    <button
      v-else-if="!known && !offline"
      type="button"
      class="btn btn--link acct__signin"
      @click="openAccount"
    >
      Sign in
    </button>

    <!-- signed in, or offline in either shape: a trigger and the card it opens -->
    <div v-else ref="menuRef" class="menu" :class="{ 'acct--offline': offline }">
      <Tooltip :text="offline ? 'Offline' : 'Your account'" preferred-placement="bottom" :disabled="open">
      <button
        type="button"
        class="btn btn--icon btn--ghost menu__btn"
        :aria-label="offline ? (known ? `Your account. ${offlineHead}.` : offlineHead) : 'Your account'"
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
        <SvgIcon v-if="offline" :icon="IconCloudOff" aria-hidden="true" />
        <span v-else class="avatar" aria-hidden="true"><span class="avatar__letter">{{ initial }}</span></span>
      </button>
      </Tooltip>
      <Transition name="menu">
        <MenuList v-if="open" :aria-label="offline ? offlineHead : 'Your account'">
          <!-- what the struck cloud means, said in full where it was pressed. Not a row:
               nothing here is pressed, so the travelling plate passes it by. -->
          <li v-if="offline" role="none" class="acct__offline">
            <p class="acct__offhead">{{ offlineHead }}</p>
            <p v-if="offlineLine" class="acct__offline-line t-muted">{{ offlineLine }}</p>
          </li>
          <li v-if="!known && unreachable" role="none">
            <button type="button" data-row role="menuitem" class="menu__item" @click="open = false; openAccount()">
              <SvgIcon :icon="IconUserKey" aria-hidden="true" />
              Sign in
            </button>
          </li>
          <li v-if="known && showGear" role="none">
            <NuxtLink to="/gear" data-row role="menuitem" class="menu__item" @click="open = false">
              <SvgIcon :icon="IconSafeSimple" aria-hidden="true" />
              My Gear
            </NuxtLink>
          </li>
          <li v-if="known" role="none">
            <button type="button" data-row role="menuitem" class="menu__item" @click="open = false; openAccount()">
              <SvgIcon :icon="IconUser" aria-hidden="true" />
              Your account
            </button>
          </li>
          <li v-if="known" role="none">
            <button type="button" data-row role="menuitem" class="menu__item" @click="onSignOut">
              <SvgIcon :icon="IconArrowBoxLeft" aria-hidden="true" />
              Sign out
            </button>
          </li>
        </MenuList>
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
/* The offline card's words: a title in the menu rows' ink and a line under it in the
   quieter one, inset like a row so it sits on the rows' left edge when they follow. A
   measure of its own, since the card is otherwise as wide as its longest row and with
   no rows that is nothing to go by. */
.acct__offline {
  width: 15rem;
  max-width: calc(100vw - var(--space-6));
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-chrome);
  white-space: normal;
}
.acct__offhead {
  font-weight: 600;
  color: var(--ink);
}
/* ON A PHONE THE OFFLINE CARD RUNS THE BAR'S WIDTH. A menu's card hangs from the right
   edge of the control that opened it and grows leftward (.menu__list, controls.scss),
   which suits a control at the end of the bar. This one is two icons in, so its card
   hung off to the left of the cloud, over the list's switcher, with nothing lining it
   up. So here the card is placed against the bar and not the button: the .menu stops
   being its containing block, the sticky bar is the next one up, and the card sits a
   gutter in from each side, directly under the bar. */
@media (max-width: 480px) {
  .acct--offline {
    position: static;
  }
  .acct--offline .menu__list {
    inset-inline: var(--space-2);
    width: auto;
    /* as close to its control as any menu is to its own: measured from the bar now, so
       the bar's bottom padding (--space-3, both bars) is taken back off the usual gap.
       Left at the bar's foot it hung a full padding lower than the menus beside it. */
    top: calc(100% - var(--space-3) + var(--space-1));
  }
  .acct--offline .acct__offline {
    width: auto;
    max-width: none;
  }
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
   semibold: the icons draw a flat 1.5px line,
   which is a 14px medium stem; semibold read as a bold black mark in a row of thin
   grey lines.
   Sized like the glyphs beside it, in --tpx: they grow with the type past the 1920px
   anchor now, and a disc left at 22px shrank beside them to a dot (Ryan: "this got too
   small"). 24 beside the 20px glyphs on every pointer, the disc a phone already drew.
   The letter is 0.64 of the disc, so the two move together past the anchor.
   The letter is trimmed to its cap so the cap itself is centred, not its rounded line
   box (which sat up to 0.4px low at some zooms). */
.avatar {
  --avatar: calc(24 * var(--tpx));
  display: inline-grid;
  place-items: center;
  width: var(--avatar);
  height: var(--avatar);
  border-radius: var(--radius-pill);
  background: var(--lit);
  font-size: calc(var(--avatar) * 0.64);
  font-weight: 500;
  line-height: 1;
  letter-spacing: 0;
  text-transform: uppercase;
  transition: background var(--spring-fade-dur) var(--spring-fade);
}
.avatar__letter {
  text-box: trim-both cap alphabetic;
}
@media (hover: hover) and (pointer: fine) {
  .menu__btn:hover .avatar {
    background: var(--lit-hover);
  }
}
</style>
