<script setup lang="ts">
import { STARTER_FOLDERS } from "~~/shared/categories";
import { uid } from "~~/shared/id";
import type { Folder, ListSnapshot } from "~~/shared/types";

// No marketing home — opening the site lands you straight in a fresh list. This
// page just mints a new list and forwards into the editor.
definePageMeta({ layout: false });

const router = useRouter();
const failed = ref(false);

async function create() {
  failed.value = false;
  try {
    const folders: Folder[] = STARTER_FOLDERS.map((p, i) => ({
      id: uid(),
      name: p.name,
      colorKey: p.colorKey,
      defaultClassification: p.defaultClassification,
      sortOrder: i,
    }));
    const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>("/api/lists/create", {
      method: "POST",
      body: { title: "Untitled list", data: { folders, items: [] } },
    });
    // replace (not push) so Back doesn't bounce here and re-create another list
    router.replace(`/e#${useMyLists().registerCreated(res)}`);
  } catch {
    failed.value = true;
  }
}

onMounted(create);
</script>

<template>
  <div class="landing">
    <template v-if="failed">
      <p class="t-muted">Couldn’t start a new list.</p>
      <button class="btn btn--primary" @click="create">Try again</button>
    </template>
    <p v-else class="t-muted">Starting a new list…</p>
  </div>
</template>

<style scoped>
.landing {
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
}
</style>
