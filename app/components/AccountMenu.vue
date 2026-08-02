<script setup lang="ts">
import { KeyRound, LogIn } from "@lucide/vue";

// The account affordance in the top bar. Two shapes, because signed in and signed
// out are different jobs:
//
//   signed out — a LINK, straight to /account. One destination, so a menu would be
//                a dropdown with a single item in it.
//   signed in  — a menu, because there are now three things you might want and
//                only one of them (your vault) deserves the bar's limited room.
//
// A DIFFERENT icon each way, not one glyph in two states: LogIn (a door you step
// through) when there's no account yet, KeyRound (the passkey that opens it) once
// there is. The two jobs read apart at a glance, which is the point — you should be
// able to tell whether you're signed in without opening anything.
//
// Signed out was these words, "Sign in", until the editor's bar ran out of room for
// them: text is 60px against an icon's 44, and that difference clipped the toolbar
// below 350px. An icon costs a little discoverability and buys a bar that fits every
// phone; the aria-label still says "Sign in", so nothing is lost to a screen reader.
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
const { signedIn, hasSessionHint, signOut } = useSession();
const route = useRoute();

// The hint alone decides the shape — it carries no capability, and being wrong
// costs one 401 on a page the person asked for anyway. Waiting for the session to
// resolve would make the control change under the cursor on every load.
const known = ref(false);
onMounted(() => (known.value = hasSessionHint() || signedIn.value));
watch(signedIn, (yes) => (known.value = yes || hasSessionHint()));

const open = ref(false);
const menuRef = useTemplateRef<HTMLElement>("menuRef");
// same close behaviour as the editor kebab and ReadonlyMenu: the action itself, an
// outside tap, or Escape
onClickOutside(menuRef, () => (open.value = false));
useWindowEvent("keydown", (e) => {
  if (e.key === "Escape" && open.value) open.value = false;
});

async function onSignOut() {
  open.value = false;
  await signOut();
  // drop both per-account memos so the next person to sign in on this device
  // starts clean rather than inheriting "already sent" / "already claimed"
  resetVaultCapture();
  useClaimedLists().resetClaimMark();
  await navigateTo("/e");
}

// Never link to the page you're already on — it reads as an action and does
// nothing. Applies to both shapes.
const onAccount = computed(() => route.path === "/account");
const onVault = computed(() => route.path === "/vault");
</script>

<template>
  <ClientOnly>
    <NuxtLink
      v-if="!known"
      v-show="!onAccount"
      to="/account"
      class="btn btn--icon btn--ghost acct__signin"
      aria-label="Sign in"
      title="Sign in"
    >
      <LogIn :size="16" />
    </NuxtLink>

    <div v-else ref="menuRef" class="menu">
      <button
        type="button"
        class="btn btn--icon btn--ghost menu__btn"
        aria-label="Your account"
        aria-haspopup="true"
        :aria-expanded="open"
        @click="open = !open"
      >
        <KeyRound :size="16" />
      </button>
      <Transition name="menu">
        <ul v-if="open" class="popover menu__list" role="menu" aria-label="Your account">
          <li v-if="!onVault" role="none">
            <NuxtLink to="/vault" role="menuitem" class="menu__item" @click="open = false">
              Your gear vault
            </NuxtLink>
          </li>
          <li v-if="!onAccount" role="none">
            <NuxtLink to="/account" role="menuitem" class="menu__item" @click="open = false">
              Your account
            </NuxtLink>
          </li>
          <li role="none">
            <button type="button" role="menuitem" class="menu__item" @click="onSignOut">
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
/* the signed-in kebab gets its colour from .menu__btn; the signed-out link is a
   plain icon button, so it takes the same quiet ink to match */
.acct__signin {
  color: var(--ink-2);
}
</style>
