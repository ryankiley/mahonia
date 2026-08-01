<script setup lang="ts">
import { KeyRound } from "@lucide/vue";

// The account affordance in the top bar — the way IN when signed out, and the way
// to your account when signed in. Deliberately NOT an avatar.
//
// An account here stores an optional display name and a possibly-absent email —
// there is no photo and never will be, so an avatar would render as a circle with
// a question mark in it for most people. It would also signal a profile product,
// which this isn't: an account exists so your gear follows you, not so there's
// someone to be on this site.
//
// Always present, because a sign-in nobody can find is not a sign-in — but it
// changes word rather than appearing and disappearing, so the bar doesn't reflow
// once the session resolves.
//
// The state comes from the readable hint cookie, not a session lookup: /e is
// prerendered and CDN-served with no function invocation, and the overwhelming
// majority of visitors have no account, so making them pay a round-trip on first
// paint to be told "no" is a real cost for no benefit. Reading a cookie that isn't
// there is free.
//
// Rendered client-side only. The server has no idea who's asking on a prerendered
// route, so anything else would either flash the wrong state or force the page off
// the CDN.
const { signedIn, hasSessionHint } = useSession();

// The hint alone decides the wording — it carries no capability, and being wrong
// costs one 401 on a page the person asked for anyway. Waiting for the session to
// resolve would make the label change under the cursor on every load.
const known = ref(false);
onMounted(() => (known.value = hasSessionHint() || signedIn.value));
watch(signedIn, (yes) => (known.value = yes || hasSessionHint()));
</script>

<template>
  <ClientOnly>
    <NuxtLink
      to="/account"
      class="btn btn--link acctlink"
      :title="known ? 'Your account' : 'Sign in'"
    >
      <KeyRound :size="15" :stroke-width="2" aria-hidden="true" />
      <span class="acctlink__text">{{ known ? "Account" : "Sign in" }}</span>
    </NuxtLink>
  </ClientOnly>
</template>

<style scoped>
.acctlink {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
/* On a narrow screen the glyph carries it alone — the top bar already holds the
   wordmark and the page's own action, and this is the least important of the
   three. The label stays in the accessible name via the title. */
@media (max-width: 30rem) {
  .acctlink__text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
</style>
