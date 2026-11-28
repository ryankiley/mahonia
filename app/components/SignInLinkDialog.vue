<script setup lang="ts">
// What a sign-in link may need to ask, over the page it was asked from.
//
// The link's state lives in useSignInLink, which says why the questions are asked here
// and not on the link's own page. This file is the card (the sign-in card, SignInHead.vue)
// and the one thing that belongs to the moment of asking: when a press counts.
const { state, deviceLists, confirm, retry, addLists, decline } = useSignInLink();

/** this browser made exactly one list: the lists question says "it", not "them" */
const one = computed(() => deviceLists() === 1);
// The card's title, which is also its accessible name: one per question.
const title = computed(() => {
  switch (state.question) {
    case "confirm":
      return `Sign in as ${state.asking.email}?`;
    case "lists":
      return `Add this browser’s ${one.value ? "list" : "lists"} to your account?`;
    default:
      // nothing has failed while there is no network to fail on
      return state.offline ? "You’re offline" : "Couldn’t sign you in";
  }
});

// BACK ONLINE, IT SIGNS IN BY ITSELF. Offline the card is a wait, not an error, so the
// wait ends when its reason does: the connection returning, the tab coming back to the
// front, or a slow clock (useRetryWhile), with the button there for anyone who would
// rather press.
useRetryWhile(
  computed(() => state.open && state.question === "error" && state.offline && !state.busy),
  () => void retry(),
);

// A PRESS IS ONLY AN ANSWER IF THE QUESTION WAS THERE FIRST. Another site can open
// a sign-in link under a click the person is already making for something else: the
// second half of a double-click, or the one that brings this window forward. So a
// press counts only once its question has been on screen, in a focused window,
// for a moment. Nobody reads "Sign in as …?" faster than this. The button shows
// it (disabled until then), so a press that came too soon is seen not to have
// landed rather than seeming to do nothing.
const READ_MS = 700;
const armed = ref(false);
let arming: ReturnType<typeof setTimeout> | undefined;
function rearm() {
  // the card stays mounted once it has been shown; closed, there is no question to read
  if (!state.open) return;
  armed.value = false;
  clearTimeout(arming);
  arming = setTimeout(() => (armed.value = true), READ_MS);
}
// each question is read afresh, and so is one that comes back after a failed try
watch([() => state.open, () => state.question], rearm, { immediate: true });
useWindowEvent("focus", rearm);
onMounted(() => document.addEventListener("visibilitychange", rearm));
onBeforeUnmount(() => {
  clearTimeout(arming);
  document.removeEventListener("visibilitychange", rearm);
});

const ready = computed(() => armed.value && !state.busy);
const onConfirm = () => ready.value && void confirm();
const onAddLists = () => ready.value && void addLists();
</script>

<template>
  <BaseModal :open="state.open" :label="title" @close="decline">
    <!-- "Sign in as" stays whole, so the only place this title can break is in front of
         the address. An address has no spaces, and balancing the two lines around it
         (reset.scss, every heading) sent "as" down to keep it company: "Sign in" over
         "as sam@example.com?". -->
    <SignInHead>
      <template v-if="state.question === 'confirm'">
        <span class="signin__keep">Sign in as</span> {{ state.asking.email }}?
      </template>
      <template v-else>{{ title }}</template>
    </SignInHead>

    <div class="signin__body">
      <template v-if="state.question === 'confirm'">
        <!-- One sentence, in the button's own verb: who should press it. It ran to two
             paragraphs and 33 words, with the reason for asking told before the thing
             asked, and a second sentence about passkeys being removed. That one went:
             the browser that asked for the link signs in with no question and so never
             saw it, and the removal it described happens there just the same. -->
        <p class="t-muted">
          {{
            state.asking.asked
              ? "Only sign in if you asked for this link in another browser."
              : "Only sign in if this address is yours."
          }}
        </p>
        <div class="signin__actions">
          <button type="button" class="btn btn--primary" :disabled="!ready" @click="onConfirm">
            {{ state.busy ? "Signing in…" : "Sign in" }}
          </button>
          <button type="button" class="btn btn--soft" @click="decline">Not me</button>
        </div>
      </template>

      <template v-else-if="state.question === 'lists'">
        <!-- One sentence that says what adding them gets you AND whose account it is. The
             account stays named: this is asked after a sign-in that may have been one
             press on a link someone else sent, and it is what the lists are being given
             to. It was two sentences, the first only announcing the sign-in. -->
        <p class="t-muted">
          {{ one ? "It’ll" : "They’ll" }} open anywhere you sign in as {{ state.asking.email }}.
        </p>
        <!-- the sign-in form's red callout, with no point: there is no field here to point
             at. "Not now" is on the card already, so the line only says to try again. -->
        <p v-if="state.addFailed" class="errtip errtip--nopoint" role="alert">
          Couldn’t add {{ one ? "it" : "them" }}. Try again.
        </p>
        <div class="signin__actions">
          <button type="button" class="btn btn--primary" :disabled="!ready" @click="onAddLists">
            {{ state.busy ? "Adding…" : one ? "Add list" : "Add lists" }}
          </button>
          <button type="button" class="btn btn--soft" @click="decline">Not now</button>
        </div>
      </template>

      <template v-else>
        <!-- ONE BUTTON. It was "Try again" over "Get a new link", under a line that only
             named the two again, and nothing said how they differed. The retry is the
             button; a retry that fails too goes on by itself to the form for a new
             link (useSignInLink). The line says what happened and vouches for nothing:
             a failed request cannot know whether the link survived it. -->
        <p class="t-muted">
          {{ state.offline ? "You’ll be signed in when you’re back online." : "Something went wrong on the way." }}
        </p>
        <div class="signin__actions">
          <!-- It says what it tries: the sign-in, with the link already opened. "Try again"
               alone was read as asking for another email. And it says so while it is
               doing it, as Continue says "Sending…": a press that only greyed the
               button looked like a press that did nothing. -->
          <button type="button" class="btn btn--primary" :disabled="state.busy" @click="retry">
            {{ state.busy ? "Signing in…" : "Try signing in again" }}
          </button>
        </div>
      </template>
    </div>
  </BaseModal>
</template>
