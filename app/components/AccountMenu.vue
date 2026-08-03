<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
// UserRoundKey is a lucide name with no hugeicons twin; UserLock01 is the nearest
// person-plus-credentials glyph.
import { UserCircleIcon, UserLock01Icon } from "@hugeicons/core-free-icons";

// The account affordance in the top bar. Two shapes, because signed in and signed
// out are different jobs:
//
//   signed out — a plain "Sign in" link. One destination, so a menu would be a
//                dropdown with a single item in it.
//   signed in  — a menu, because there are now three things you might want and
//                only one of them (your vault) deserves the bar's limited room.
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
const { compact = false } = defineProps<{ compact?: boolean }>();

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
    <!-- signed out: one destination, so a link and not a menu. Icon in the editor's
         glyph row, words in the site bar. -->
    <Tooltip v-if="!known && compact" text="Sign in" preferred-placement="bottom">
      <NuxtLink
        v-show="!onAccount"
        to="/account"
        class="btn btn--icon btn--ghost acct__signinbtn"
        aria-label="Sign in"
      >
        <HugeiconsIcon :icon="UserLock01Icon" :size="16" :stroke-width="2" />
      </NuxtLink>
    </Tooltip>
    <NuxtLink
      v-else-if="!known"
      v-show="!onAccount"
      to="/account"
      class="btn btn--link acct__signin"
    >
      Sign in
    </NuxtLink>

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
.acct__signin {
  white-space: nowrap;
}
</style>
