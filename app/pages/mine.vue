<script setup lang="ts">
import { editLinkPath } from "~~/shared/links";
import type { MyListEntry } from "~~/shared/types";
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

const editPath = (e: MyListEntry) => editLinkPath(e.shareCode, e.editToken);
const displayTitle = (t: string) => {
  const n = t?.trim();
  return n && n !== "Untitled list" ? n : "Untitled list";
};

const busy = ref<string | null>(null); // editToken mid-delete
const error = ref("");

// Remove from THIS device only — the list stays online for anyone with a link.
function removeFromDevice(e: MyListEntry) {
  if (!confirm(`Remove “${displayTitle(e.title)}” from this device? The list stays online — you'll need its edit link to open it again.`)) return;
  error.value = "";
  my.forget(e.editToken);
}
// Delete the list itself (server soft-delete + forget locally).
async function deleteList(e: MyListEntry) {
  if (!confirm(`Delete “${displayTitle(e.title)}” for everyone? Anyone with the link will lose it, and this can't be undone.`)) return;
  error.value = "";
  busy.value = e.editToken;
  const ok = await my.deleteList(e.editToken);
  busy.value = null;
  if (!ok) error.value = "Couldn’t delete that list — check your connection and try again.";
}
</script>

<template>
  <div>
    <SiteTopbar>
      <span class="t-sm t-muted">Your lists</span>
      <NuxtLink to="/e" class="btn btn--link">New list</NuxtLink>
    </SiteTopbar>

    <main class="wrap page">
      <div class="mine__head">
        <h1 class="t-title">Your lists</h1>
        <p class="t-sm t-muted mine__sub">
          Saved on this device. Clear your browser and they’re gone — keep a list’s edit link to
          open it anywhere else.
        </p>
      </div>

      <ClientOnly>
        <p v-if="error" class="t-sm mine__error">{{ error }}</p>

        <ul v-if="lists.length" class="mine__list">
          <li v-for="e in lists" :key="e.editToken" class="mine__row">
            <div class="mine__main">
              <NuxtLink :to="editPath(e)" class="mine__title">{{ displayTitle(e.title) }}</NuxtLink>
              <p class="t-sm t-muted mine__meta">
                {{ timeAgo(e.lastOpened) }}<template v-if="e.totalMg > 0"> · {{ formatWeightAuto(e.totalMg) }}</template>
              </p>
            </div>
            <div class="mine__actions">
              <button type="button" class="mine__act" @click="removeFromDevice(e)">Remove from device</button>
              <button type="button" class="mine__act" :disabled="busy === e.editToken" @click="deleteList(e)">Delete</button>
            </div>
          </li>
        </ul>

        <div v-else class="mine__empty">
          <p class="t-muted">No lists saved on this device yet.</p>
          <NuxtLink to="/e" class="btn btn--primary">Make a list</NuxtLink>
        </div>

        <template #fallback>
          <p class="t-muted mine__empty">Loading your lists…</p>
        </template>
      </ClientOnly>
    </main>
  </div>
</template>

<style scoped>
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
.mine__title {
  color: var(--ink);
  font-weight: 600;
  font-size: var(--text-title);
  letter-spacing: -0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mine__title:hover {
  text-decoration: underline;
  text-decoration-color: var(--line-2);
  text-underline-offset: 2px;
}
.mine__meta {
  white-space: nowrap;
}
/* quiet actions — monochrome, darken on hover (destructive isn't coloured) */
.mine__actions {
  flex: none;
  display: flex;
  gap: var(--space-4);
}
.mine__act {
  padding: 0;
  background: none;
  border: 0;
  font-size: var(--text-sm);
  color: var(--ink-3);
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--dur) var(--ease);
}
.mine__act:hover {
  color: var(--ink);
}
.mine__act:disabled {
  opacity: 0.5;
  cursor: default;
}
.mine__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-4);
}

@media (max-width: 560px) {
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
