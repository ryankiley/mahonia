<script setup lang="ts">
import { STARTER_FOLDERS } from "~~/shared/categories";
import type { Folder, ListData, ListSnapshot } from "~~/shared/types";
import { formatWeight } from "~~/shared/weights";
import { csvToListData } from "~~/shared/exporters/csv";

const myLists = useMyLists();
const router = useRouter();
const creating = ref(false);

const uid = () =>
  crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

async function newList() {
  if (creating.value) return;
  creating.value = true;
  try {
    const folders: Folder[] = STARTER_FOLDERS.map((p, i) => ({
      id: uid(),
      name: p.name,
      colorKey: p.colorKey,
      defaultClassification: p.defaultClassification,
      sortOrder: i,
    }));
    const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>(
      "/api/lists/create",
      { method: "POST", body: { title: "Untitled list", data: { folders, items: [] } } },
    );
    myLists.upsert({
      editToken: res.editToken,
      shareCode: res.snapshot.shareCode,
      slug: res.snapshot.slug,
      title: res.snapshot.title,
      totalMg: 0,
      version: res.snapshot.version,
      lastOpened: Date.now(),
    });
    router.push(`/e#${res.editToken}`);
  } finally {
    creating.value = false;
  }
}

function removeList(editToken: string) {
  // the edit token is the ONLY copy of the write capability — confirm before dropping it
  if (
    confirm(
      "Remove this list from this device? You'll lose edit access unless you've saved its edit link elsewhere.",
    )
  ) {
    myLists.forget(editToken);
  }
}

// ---- import (LighterPack CSV / spreadsheet) ----
const showImport = ref(false);
const importText = ref("");
const importing = ref(false);
const importError = ref("");

async function importData(data: ListData) {
  if (!data.items.length) {
    importError.value = "No items found — paste a CSV with a header row.";
    return;
  }
  importing.value = true;
  importError.value = "";
  try {
    const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>("/api/lists/create", {
      method: "POST",
      body: { title: "Imported list", data },
    });
    myLists.upsert({
      editToken: res.editToken,
      shareCode: res.snapshot.shareCode,
      slug: res.snapshot.slug,
      title: res.snapshot.title,
      totalMg: 0,
      version: res.snapshot.version,
      lastOpened: Date.now(),
    });
    router.push(`/e#${res.editToken}`);
  } catch {
    importError.value = "Import failed — check the CSV and try again.";
  } finally {
    importing.value = false;
  }
}
function importFromText() {
  importData(csvToListData(importText.value));
}
function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => importData(csvToListData(String(reader.result)));
  reader.readAsText(file);
}
</script>

<template>
  <div>
    <header class="hero topo">
      <div class="wrap hero__inner">
        <p class="t-label">Gear · pack lists, weighed</p>
        <h1 class="t-display hero__title">Make a packing list.<br />See what it weighs.</h1>
        <p class="hero__sub t-muted">
          A calm place to build a list and share it. Weights are optional — add
          them when you care. No login.
        </p>
        <div class="hero__ctas">
          <button class="btn btn--primary hero__cta" :disabled="creating" @click="newList">
            {{ creating ? "Starting…" : "Start a list" }}
          </button>
          <button class="btn btn--ghost" @click="showImport = !showImport">Import a list</button>
        </div>

        <div v-if="showImport" class="import panel">
          <p class="t-sm t-muted">
            Paste a CSV — LighterPack’s “Export to CSV”, or any spreadsheet — or choose a file.
          </p>
          <textarea
            v-model="importText"
            class="field import__text"
            rows="5"
            placeholder="Category,Item Name,Qty,Weight,Unit,Worn,Consumable…"
          />
          <div class="import__actions">
            <input type="file" accept=".csv,.tsv,text/csv,text/plain" @change="onFile" />
            <button
              class="btn btn--sm btn--primary"
              :disabled="importing || !importText.trim()"
              @click="importFromText"
            >
              {{ importing ? "Importing…" : "Import" }}
            </button>
          </div>
          <p v-if="importError" class="t-sm import__err">{{ importError }}</p>
        </div>
      </div>
    </header>

    <main class="wrap mylists">
      <div class="spread mylists__head">
        <h2 class="t-title">Your lists</h2>
        <span class="t-xs t-faint">saved in this browser</span>
      </div>

      <p v-if="!myLists.all.value.length" class="t-muted mylists__empty">
        Nothing yet. Start a list above — it’ll show up here next time you visit.
      </p>

      <ul v-else class="mylists__grid">
        <li v-for="l in myLists.all.value" :key="l.editToken">
          <NuxtLink :to="`/e#${l.editToken}`" class="card">
            <span class="card__title t-title">{{ l.title || "Untitled list" }}</span>
            <span class="card__meta t-xs t-muted">
              <template v-if="l.totalMg > 0">
                <span class="t-num">{{ formatWeight(l.totalMg, "g") }}</span> total
              </template>
              <template v-else>no weights yet</template>
            </span>
            <button
              class="btn btn--icon btn--ghost card__del"
              title="Remove from this device (you lose edit access)"
              aria-label="Remove from this device (you lose edit access)"
              @click.prevent="removeList(l.editToken)"
            >
              ✕
            </button>
          </NuxtLink>
        </li>
      </ul>
    </main>
  </div>
</template>

<style scoped>
.hero {
  border-bottom: 1px solid var(--line-2);
}
.hero__inner {
  padding-block: var(--space-8) var(--space-7);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.hero__title {
  max-width: 16ch;
}
.hero__sub {
  max-width: 46ch;
  font-size: var(--text-base);
}
.hero__ctas {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-2);
  flex-wrap: wrap;
}
.hero__cta {
  min-height: 48px;
  padding-inline: var(--space-6);
}
.import {
  margin-top: var(--space-4);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 48rem;
}
.import__text {
  width: 100%;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  border: 1px solid var(--line);
  padding: var(--space-3);
  resize: vertical;
}
.import__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.import__err {
  color: var(--cat-firstaid);
}
.mylists {
  padding-block: var(--space-7);
}
.mylists__head {
  margin-bottom: var(--space-4);
}
.mylists__empty {
  padding: var(--space-6) 0;
}
.mylists__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-3);
}
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  background: var(--paper-2);
  transition: background var(--dur) var(--ease);
}
.card:hover {
  background: var(--paper-3);
}
.card__del {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  color: var(--ink-3);
  opacity: 0;
}
.card:hover .card__del {
  opacity: 1;
}
</style>
