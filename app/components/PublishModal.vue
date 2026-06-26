<script setup lang="ts">
import { Copy, Globe, Lock } from "@lucide/vue";
import { SEASONS, TRIP_TYPES } from "~~/shared/discovery";

// The "Make public" dialog. Mounted once in the editor; opened via usePublish().
const { isOpen, state, loading, submitting, close, submit } = usePublish();
const emit = defineEmits<{ done: [{ status: string }] }>();

const trip = ref("");
const season = ref("");
const copied = ref(false);

const isPublic = computed(() => !!state.value?.isPublic);
const pendingReview = computed(() => isPublic.value && !!state.value?.flagged);
const publicPath = computed(() => (state.value ? `/l/${state.value.slug}` : ""));
const origin = () => (typeof location !== "undefined" ? location.origin : "");
const publicUrl = computed(() => origin() + publicPath.value);

// seed the facet selectors from the loaded/updated state
watch(state, (s) => {
  trip.value = s?.tripType ?? "";
  season.value = s?.season ?? "";
});

async function save(makePublic: boolean) {
  const res = await submit({
    isPublic: makePublic,
    tripType: trip.value || null,
    season: season.value || null,
  });
  if (res)
    emit("done", {
      status: !res.isPublic ? "private" : res.flagged ? "pending" : "public",
    });
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(publicUrl.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard blocked — the link is visible to copy by hand */
  }
}

onKeyStroke("Escape", () => isOpen.value && close());
</script>

<template>
  <Transition name="ovl">
    <div v-if="isOpen" class="ovl" @click.self="close()">
      <div class="dlg panel" role="dialog" aria-modal="true" aria-label="Publish list">
        <p class="t-label">Discovery feed</p>

        <p v-if="loading" class="t-muted">Loading…</p>

        <template v-else>
          <p class="dlg__head">
            <component :is="isPublic ? Globe : Lock" :size="18" :stroke-width="2" />
            <span>{{ isPublic ? "This list is public" : "Keep this list private" }}</span>
          </p>
          <p class="t-sm t-muted dlg__lede">
            Public lists appear on the discovery feed for anyone to browse. Only the read-only
            view is shared — your edit link stays private.
          </p>

          <label class="dlg__field">
            <span class="t-sm t-muted">Trip type</span>
            <select v-model="trip" class="field">
              <option value="">— none —</option>
              <option v-for="t in TRIP_TYPES" :key="t.slug" :value="t.slug">{{ t.label }}</option>
            </select>
          </label>
          <label class="dlg__field">
            <span class="t-sm t-muted">Season</span>
            <select v-model="season" class="field">
              <option value="">— none —</option>
              <option v-for="s in SEASONS" :key="s.slug" :value="s.slug">{{ s.label }}</option>
            </select>
          </label>

          <div v-if="isPublic" class="dlg__link">
            <span class="t-sm t-muted">Public link</span>
            <div class="dlg__linkrow">
              <a class="t-sm dlg__url" :href="publicUrl" target="_blank" rel="noreferrer noopener">{{ publicPath }}</a>
              <button class="btn btn--sm" @click="copyLink">
                <Copy :size="14" /> {{ copied ? "Copied" : "Copy" }}
              </button>
            </div>
            <p v-if="pendingReview" class="t-sm dlg__pending">
              Pending review — lists with lots of links are held back from the feed.
            </p>
          </div>

          <div class="dlg__actions">
            <button v-if="isPublic" class="btn btn--ghost dlg__danger" :disabled="submitting" @click="save(false)">
              Make private
            </button>
            <span class="dlg__spacer" />
            <button class="btn btn--ghost" @click="close()">Done</button>
            <button
              class="btn btn--primary"
              :disabled="submitting"
              @click="save(true)"
            >
              {{ submitting ? "Saving…" : isPublic ? "Save" : "Publish" }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* overlay + dialog shell live in atoms/dialog.scss; only the publish-specific
   body is scoped here */
.dlg__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: -0.02em;
}
.dlg__link {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
  margin-top: var(--space-1);
  border-top: 1px solid var(--line);
}
.dlg__linkrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.dlg__url {
  color: var(--ink);
  text-decoration: underline;
  word-break: break-all;
}
.dlg__pending {
  color: var(--ink-2);
}
.dlg__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.dlg__spacer {
  flex: 1;
}
.dlg__danger {
  color: var(--ink-2);
}
</style>
