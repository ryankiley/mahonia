<script setup lang="ts">
import { Trash2 } from "@lucide/vue";
import { editLinkPath } from "~~/shared/links";
import type { MyListEntry, Unit } from "~~/shared/types";
import { formatWeightAuto } from "~~/shared/weights";

// "Your lists" — the no-login stand-in for an account. It's a read-out of the
// device-local registry useMyLists already keeps (the edit tokens this browser
// holds); there's no server-side user. Prerendered as a static shell + the list
// filled in client-side (the registry is localStorage), and noindex — it's
// per-device and has nothing for a crawler.
useHead({
  title: "Your lists — Mahonia",
  meta: [{ name: "robots", content: "noindex" }],
});

const my = useMyLists();
// most-recently-opened first
const lists = computed(() => [...my.entries.value].sort((a, b) => b.lastOpened - a.lastOpened));

const { confirm: askConfirm } = useDialogs();

const editPath = (e: MyListEntry) => editLinkPath(e.shareCode, e.editToken);
const displayTitle = (t: string) => {
  const n = t?.trim();
  return n && n !== "Untitled list" ? n : "Untitled list";
};
// summarise the total in the list's own unit system (imperial lists → lb/oz),
// falling back to metric auto for legacy entries that predate the stored unit
const systemOf = (u?: Unit) => (u === "oz" || u === "lb" ? "imperial" : "metric");
const totalLabel = (e: MyListEntry) => formatWeightAuto(e.totalMg, { system: systemOf(e.displayUnit) });

const busy = ref<string | null>(null); // editToken mid-delete
const error = ref("");

// Remove from THIS device only — the list stays online for anyone with a link.
async function removeFromDevice(e: MyListEntry) {
  if (!(await askConfirm({
    title: "Remove from this device",
    message: `Remove “${displayTitle(e.title)}” from this device? The list stays online. You'll need its edit link to open it again.`,
    confirmLabel: "Remove",
  }))) return;
  error.value = "";
  my.forget(e.editToken);
}
// Delete the list itself (server soft-delete + forget locally).
async function deleteList(e: MyListEntry) {
  if (!(await askConfirm({
    title: "Delete for everyone",
    message: `Delete “${displayTitle(e.title)}” for everyone? Anyone with the link will lose it, and this can't be undone.`,
    confirmLabel: "Delete",
    danger: true,
  }))) return;
  error.value = "";
  busy.value = e.editToken;
  const ok = await my.deleteList(e.editToken);
  busy.value = null;
  if (!ok) error.value = "Couldn’t delete that list. Check your connection and try again.";
}
</script>

<template>
  <div>
    <SiteTopbar>
      <NuxtLink to="/e" class="btn btn--link">Create a list</NuxtLink>
    </SiteTopbar>

    <main class="wrap page">
      <div class="mine__head">
        <h1 class="t-title">Your lists</h1>
        <p class="t-sm t-muted mine__sub">
          Saved on this device. Clear your browser and they’re gone, so keep a list’s edit link to
          open it anywhere else.
        </p>
      </div>

      <ClientOnly>
        <p v-if="error" class="t-sm mine__error">{{ error }}</p>

        <ul v-if="lists.length" class="mine__list">
          <li v-for="e in lists" :key="e.editToken" class="mine__row">
            <div class="mine__main">
              <NuxtLink :to="editPath(e)" class="t-title mine__title">{{ displayTitle(e.title) }}</NuxtLink>
              <p class="t-sm t-muted mine__meta">
                {{ timeAgo(e.lastOpened) }}<template v-if="e.totalMg > 0"> · {{ totalLabel(e) }}</template>
              </p>
            </div>
            <div class="mine__actions">
              <button type="button" class="btn btn--quiet" @click="removeFromDevice(e)">Remove from device</button>
              <button type="button" class="btn btn--quiet mine__delete" :disabled="busy === e.editToken" @click="deleteList(e)">
                <Trash2 :size="14" aria-hidden="true" /> Delete
              </button>
            </div>
          </li>
        </ul>

        <div v-else class="mine__empty">
          <p class="t-muted">No lists saved on this device yet.</p>
          <NuxtLink to="/e" class="btn btn--primary">Create a list</NuxtLink>
        </div>

        <template #fallback>
          <p class="t-muted mine__empty">Loading your lists…</p>
        </template>
      </ClientOnly>
    </main>
  </div>
</template>

<style scoped lang="scss">
.page {
  padding-block: var(--space-5) var(--space-9);
}
.mine__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-6);
}
.mine__sub {
  max-width: 52ch;
}
.mine__error {
  color: var(--ink);
  margin-bottom: var(--space-4);
}
/* de-outlined rows — separated by hairlines + whitespace, not cards */
.mine__list {
  list-style: none;
  display: flex;
  flex-direction: column;
}
.mine__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
  padding-block: var(--space-4);
}
.mine__row + .mine__row {
  border-top: 1px solid var(--line);
}
.mine__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-px);
}
/* type comes from .t-title; this just adds the link colour + single-line clamp */
.mine__title {
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mine__title:hover {
  text-decoration: underline;
  /* --ink-2, not --underline: the system's hover underlines deepen to --ink-2
     (--underline is the rest-state tone) */
  text-decoration-color: var(--ink-2);
  text-underline-offset: 2px;
}
.mine__meta {
  white-space: nowrap;
}
/* quiet monochrome text actions (.btn--quiet); destructive isn't coloured */
.mine__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
/* the destructive action carries a trash glyph so it's distinguishable at a glance
   from the harmless "Remove from device" (the chrome is monochrome, so the icon —
   not colour — does the differentiating) */
.mine__delete {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.mine__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-4);
}

@media (max-width: $bp-stack) {
  /* stack the actions under the title so nothing is cramped on a phone */
  .mine__row {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-2);
  }
  .mine__actions {
    gap: var(--space-5);
  }
}
</style>
