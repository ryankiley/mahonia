<script setup lang="ts">
// The list's live sync state + last-edit time, in one quiet text line below the
// header (so the dense top control row stays uncramped on mobile). The words carry
// the state — "Syncing…", "Synced · edited 1 hour ago", "Offline · saved on
// device" — and the state word pops on change (the translate+fade+blur the live
// total uses). Self-contained: reads the editor singleton, so callers just drop in
// <SyncStatus />.
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

// state word (announced + popped on change) and the time suffix (silent, updates
// in place) are kept apart so the 30s tick never re-announces or re-pops
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
    <!-- stable live region; the keyed inner word re-mounts + pops on state change,
         while the time suffix updates silently in place --><span
      class="syncstatus__state"
      aria-live="polite"
    ><Transition name="syncpop" mode="out-in"><span
      :key="stateWord"
      class="syncstatus__word"
    >{{ stateWord }}</span></Transition></span><span v-if="timeSuffix">{{ timeSuffix }}</span>
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
  user-select: none; /* passive status, not a control */
}
/* a genuine "Not saved" is the one state worth full ink */
.syncstatus.is-alert {
  color: var(--ink);
}
/* inline-block so the pop's translate/blur render */
.syncstatus__word {
  display: inline-block;
}
/* state-change pop — the translate+fade+blur the live total (AnimatedCount) uses,
   so a "Syncing → Synced" flip feels of a piece with the app */
@keyframes syncstatus-pop {
  from {
    opacity: 0;
    transform: translateY(0.25em) translateZ(0);
    filter: blur(var(--blur-pop));
  }
  to {
    opacity: 1;
    transform: translateY(0) translateZ(0);
    filter: blur(0);
  }
}
.syncpop-enter-active {
  animation: syncstatus-pop var(--dur-slow) var(--ease-spring) both;
}
@media (prefers-reduced-motion: reduce) {
  .syncpop-enter-active {
    animation: none;
  }
}
</style>
