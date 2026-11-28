<script setup lang="ts">
import { copyText, COPY_FAILED } from "~/utils/clipboard";

// Turn on, copy, or turn off the read-only link to My Gear (/g/{code}). What the link
// shows is fixed (shared/vaultShare.ts), so the dialog says it plainly once rather than
// offering switches: your gear and kits, never prices or food, and your name only if
// you set one on your account.
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const code = ref<string | null>(null);
const state = ref<"loading" | "ready" | "saving" | "error">("loading");
const note = ref("");

const url = computed(() =>
  code.value && import.meta.client ? `${location.origin}/g/${code.value}` : "",
);

async function load() {
  state.value = "loading";
  note.value = "";
  try {
    code.value = (
      await $fetch<{ code: string | null }>("/api/vault/share")
    ).code;
    state.value = "ready";
  } catch {
    state.value = "error";
  }
}
watch(
  () => props.open,
  (open) => open && load(),
  { immediate: true },
);

async function set(on: boolean) {
  state.value = "saving";
  note.value = "";
  try {
    const res = await $fetch<{ ok: boolean; code?: string | null }>(
      "/api/vault/share",
      { method: "POST", body: { on } },
    );
    if (!res.ok) throw new Error("refused");
    code.value = res.code ?? null;
    state.value = "ready";
    if (on && code.value) await copy();
  } catch {
    state.value = "error";
  }
}

async function copy() {
  note.value = (await copyText(url.value)) ? "Link copied." : COPY_FAILED;
}
</script>

<template>
  <BaseModal :open="open" label="Share my gear" @close="emit('close')">
    <h2 class="t-label panel__title">Share my gear</h2>

    <p class="t-muted dlg__lede">
      A read-only link to your gear and kits. Anyone with it can see names,
      weights, and specs, never prices or food. Your name shows only if you’ve
      set one on your account.
    </p>

    <p v-if="state === 'error'" class="vshare__err">
      That didn’t work. Try again in a moment.
    </p>

    <template v-if="code">
      <input
        class="field well vshare__url"
        :value="url"
        readonly
        aria-label="Link to your gear"
        @focus="($event.target as HTMLInputElement).select()"
      />
      <p class="t-muted vshare__note" aria-live="polite">
        {{
          note ||
          "Turning it off stops this link at once. Turning it on again makes a new one."
        }}
      </p>
      <div class="dlg__actions">
        <button
          class="btn btn--soft"
          :disabled="state === 'saving'"
          @click="set(false)"
        >
          Turn off
        </button>
        <button
          class="btn btn--primary"
          :disabled="state === 'saving'"
          @click="copy"
        >
          Copy link
        </button>
      </div>
    </template>

    <div v-else class="dlg__actions">
      <button class="btn btn--soft" @click="emit('close')">Cancel</button>
      <button
        class="btn btn--primary"
        :disabled="state === 'loading' || state === 'saving'"
        @click="set(true)"
      >
        {{ state === "saving" ? "Turning on…" : "Turn on and copy link" }}
      </button>
    </div>
  </BaseModal>
</template>

<style scoped lang="scss">
.vshare__url {
  width: 100%;
  margin-block: var(--space-3) var(--space-2);
}
.vshare__err {
  color: var(--foreground-primary);
}
</style>
