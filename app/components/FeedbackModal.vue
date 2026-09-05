<script setup lang="ts">
import { MAX_FEEDBACK_LEN } from "~~/shared/feedback";
// "Send feedback" — one box, one button.
//
// Deliberately without a category picker, a severity, a title field or an email
// field. Every one of those is a question the sender has to answer before saying the
// thing they came to say, and each one is answerable by whoever reads the issue.
// The friction being near zero IS the design: the reports you never get are the ones
// that needed a form filled in first.
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

// the SAME cap the endpoint enforces — see shared/feedback.ts for why it is one
// constant and not two that happen to match
const MAX = MAX_FEEDBACK_LEN;
const message = ref("");
const state = ref<"idle" | "sending" | "sent">("idle");
const error = ref("");
const boxRef = useTemplateRef<HTMLTextAreaElement>("boxRef");

const remaining = computed(() => MAX - message.value.length);
const canSend = computed(() => message.value.trim().length > 0 && state.value === "idle");

// reset on each open — a dialog that reopens holding the last message (or the last
// error) is describing a session the sender has already finished
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    message.value = "";
    error.value = "";
    state.value = "idle";
    nextTick(() => boxRef.value?.focus());
  },
  { immediate: true },
);

async function send() {
  if (!canSend.value) return;
  state.value = "sending";
  error.value = "";
  try {
    await $fetch("/api/feedback", { method: "POST", body: { message: message.value.trim() } });
    state.value = "sent";
  } catch (e) {
    state.value = "idle";
    // the endpoint's statusMessage is written for a human and says nothing about our
    // infrastructure (see the handler); anything else gets a generic line
    error.value =
      (e as { data?: { statusMessage?: string } })?.data?.statusMessage ||
      "Couldn’t send that just now. Try again in a moment.";
  }
}
</script>

<template>
  <BaseModal :open="open" label="Send feedback" @close="emit('close')">
    <div class="fb">
      <h2 class="t-label fb__title">Send feedback</h2>

      <template v-if="state === 'sent'">
        <p class="t-sm">Thanks. That’s been sent.</p>
        <div class="dlg__actions">
          <button type="button" class="btn btn--primary" @click="emit('close')">Close</button>
        </div>
      </template>

      <template v-else>
        <p class="t-sm t-muted fb__lede">Bugs, missing gear, ideas. Anything.</p>

        <textarea
          ref="boxRef"
          v-model="message"
          class="field well fb__box"
          :maxlength="MAX"
          rows="5"
          placeholder="What’s on your mind?"
          aria-label="Your feedback"
          @keydown.meta.enter="send"
          @keydown.ctrl.enter="send"
        />

        <div class="fb__meta">
          <!-- This goes to a PUBLIC tracker. Saying so before the button, in plain
               words, is the whole point: someone will otherwise paste an email
               address or a whole gear list into a repository anyone can read. It is a
               requirement of the feature, not a disclaimer. -->
          <p class="t-sm t-muted fb__notice">
            This is posted publicly to the issue tracker. Don’t include anything private.
          </p>
          <p class="t-sm t-muted t-num fb__count" :class="{ 'is-low': remaining <= 50 }">
            {{ remaining }}
          </p>
        </div>

        <p v-if="error" class="t-sm fb__error">{{ error }}</p>

        <div class="dlg__actions">
          <button type="button" class="btn btn--quiet" @click="emit('close')">Cancel</button>
          <button type="button" class="btn btn--primary" :disabled="!canSend" @click="send">
            {{ state === "sending" ? "Sending…" : "Send" }}
          </button>
        </div>
      </template>
    </div>
  </BaseModal>
</template>

<style scoped>
.fb {
  display: grid;
  gap: var(--space-3);
}
.fb__title {
  color: var(--ink);
}
/* .field is borderless in the row grid it was written for; in a dialog the shared
   .well tint (controls.scss) gives it ground to read as something you type into —
   a fill, not a hairline box, same as the import dialog's paste box beside it. */
.fb__box {
  min-height: 7rem;
  padding: var(--space-2);
  /* No resize, for the reason the import dialog's paste box already gives (.import__text):
     the native grip is a square widget the UA paints over the bottom-right corner, and it
     is not clipped by the border-radius — so one corner of a box whose other three are
     12px came out square. The two textareas are the same atom in the same dialog shell;
     this one just never got the fix. It scrolls, which is what it did past 7rem anyway. */
  resize: none;
}
.fb__meta {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}
.fb__notice {
  flex: 1;
}
/* the count is information, not an alarm — it only stops being muted once it is
   close enough to matter */
.fb__count.is-low {
  color: var(--ink);
}
.fb__error {
  color: var(--ink);
}
</style>
