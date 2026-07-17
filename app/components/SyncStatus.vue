<script setup lang="ts">
// The list's live sync state + last-edit time, in one quiet text line below the
// header (so the dense top control row stays uncramped on mobile). The words carry
// the state — "Syncing…", "Synced · edited 1 hour ago", "Offline · saved on
// device" — and the state word swaps in place on change. No animation here: a save
// cycle flips the word Synced→Syncing…→Synced in ~15ms, so animating a word that
// changes faster than the motion runs looked like it was racing itself. A subtler
// motion is worth revisiting, but plain-swap is the calm baseline. Self-contained:
// reads the editor singleton, so callers just drop in <SyncStatus />.
const c = useGearList();
const status = c.status;
const snapshot = c.snapshot;

// tick the relative time as it ages (30s is finer than the smallest "N minutes"
// step, so "just now" → "1 minute ago" flips promptly without a per-second churn)
const now = useNow({ interval: 30_000 });

// authoritative last write, from the server snapshot — so a collaborator's edit the
// poll pulls in moves it too. Absent on a never-server-saved draft.
const editedAt = computed(() => {
  const iso = snapshot.value?.updatedAt;
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
});

// mirrors the controller's hasRealContent gate (a name or a weight; a bare
// "Add an item" row doesn't count) — drives the empty-new-list case below
const hasContent = computed(
  () => !!snapshot.value?.items.some((i) => i.name.trim() !== "" || i.unitWeightMg > 0),
);

// state word (announced on change) and the time suffix (silent, updates in place)
// are kept apart so the 30s tick never re-announces the state
const stateWord = computed(() => {
  switch (status.value) {
    case "loading":
      return "Loading…";
    case "saving":
      return "Syncing…";
    case "offline":
      return "Offline · saved on device";
    case "error":
      return "Not saved";
    case "synced":
      // saved to the server → its last-write time; a draft with content but no
      // server time yet is held on device; an untouched empty list says nothing
      return editedAt.value != null ? "Synced" : hasContent.value ? "Saved on device" : "";
    default:
      return ""; // idle / missing
  }
});
const timeSuffix = computed(() =>
  status.value === "synced" && editedAt.value != null
    ? ` · edited ${timeAgo(editedAt.value, now.value.getTime())}`
    : "",
);

const shown = computed(() => stateWord.value !== "");
</script>

<template>
  <p v-if="shown" class="syncstatus" :class="{ 'is-alert': status === 'error' }">
    <!-- polite live region: the state word swaps in place and re-announces on
         change, while the time suffix updates silently outside it (so the 30s tick
         never re-announces) --><span
      class="syncstatus__state"
      aria-live="polite"
    >{{ stateWord }}</span><span v-if="timeSuffix">{{ timeSuffix }}</span>
  </p>
</template>

<style scoped>
.syncstatus {
  margin: 0;
  color: var(--ink-3);
  font-size: var(--text-sm);
  /* one line; a long "edited Jul 8" clips rather than wraps */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* a genuine "Not saved" is the one state worth full ink */
.syncstatus.is-alert {
  color: var(--ink);
}
</style>
