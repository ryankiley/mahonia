<script setup lang="ts">
// Where the emailed sign-in link lands.
//
// WHY A PAGE AND NOT A SERVER REDIRECT: mail gateways, link scanners and inbox
// previewers fetch every URL in a message before the human sees it. If the GET
// itself redeemed the token, a single-use link would routinely be spent before it
// arrived and the user would be told their brand-new link had "already been used".
// So this page holds the token and POSTs it to /api/auth/verify — a step a scanner
// doesn't take. It fires on mount without a click, so for the human it's still a
// single tap from the email to being signed in.
//
// IN THE BROWSER THAT ASKED, that is. Anywhere else the server answers `confirm`
// and spends nothing, and the account is named and a yes waited for: a link
// is a way into whichever account asked for it, and one a stranger sent you would
// otherwise sign this browser in as them and hand their account its lists (see
// redeemMagicLink in server/utils/authSession.ts). The lists are then a question
// of their own, after the sign-in and not part of it.
//
// THE PAGE ITSELF IS A WAYPOINT and asks nothing. The link is sent from here, and what
// happens next happens somewhere else (useSignInLink): straight back to the page the
// link was asked from, or, when there is something to ask, to that page first with the
// question in a dialog over it. All this page ever draws is the bar, and one card if
// the server is slow to answer.
const route = useRoute();

// noindex + no SSR data: the token lives in the query string and must not reach a
// crawler, a cache, or a server-rendered payload.
useHead({
  title: "Signing you in — Mahonia",
  meta: [{ name: "robots", content: "noindex" }],
});

// ONLY WHEN IT IS SLOW. The straight run is over in a few hundred milliseconds, and a
// card that appeared and vanished in that time was a flash of a dialog over an empty
// page. Past a second the empty page needs to say it is working.
const SLOW_MS = 1000;
const slow = ref(false);
let waiting: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  waiting = setTimeout(() => (slow.value = true), SLOW_MS);
  const raw = route.query.t;
  // the link is sent as the page arrives, with no click (the top of this file says why)
  void useSignInLink().arrive((Array.isArray(raw) ? raw[0] : raw) ?? "");
});
onBeforeUnmount(() => clearTimeout(waiting));
</script>

<template>
  <div>
    <SiteTopbar />
    <main id="main-content" tabindex="-1" class="wrap page" />
    <!-- nothing to answer and nothing to dismiss: it goes when the page does -->
    <BaseModal :open="slow" label="Signing you in…">
      <SignInHead>Signing you in…</SignInHead>
      <div class="signin__body">
        <p class="t-muted">One moment.</p>
      </div>
    </BaseModal>
  </div>
</template>
