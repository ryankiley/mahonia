<script setup lang="ts">
import { IconBackpack, IconSafeSimple, IconToolbox } from "~/icons/central";
import type { Unit } from "~~/shared/types";
import type { VaultEntry } from "~~/shared/vault";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from "~~/shared/ogCard";
import { counted } from "~~/shared/tidyText";
import { sharedGearSummary, sharedGearTitle, type SharedGear } from "~~/shared/vaultShare";
import { vaultSections } from "~~/shared/vaultView";

// Someone's My Gear, through the read-only link they turned on (/g/{code}). What it may
// show is decided server-side (shared/vaultShare.ts): Gear and Kits, no prices, the
// owner's name only if they set one. This page draws it with My Gear's own sections and
// rows, bare: nothing on it can be changed, and nothing about the reader is kept.
const route = useRoute();
const code = computed(() => String(route.params.code || ""));
// computed URL, as the list share page does, so a /g/a → /g/b navigation refetches
const { data } = await useFetch<SharedGear>(() => `/api/g/${code.value}`);
// never cached anywhere: the owner was told the link stops the moment it is off
useResponseHeader("Cache-Control").value = "private, no-store";
// a link that is off (or never was) answers as missing, so the page says so to anything
// reading the status, not only to a person reading the words
if (import.meta.server && !data.value)
  setResponseStatus(useRequestEvent()!, 404);

const items = computed<VaultEntry[]>(() => data.value?.items ?? []);
const pieces = computed(() => items.value.filter((e) => e.kind !== "kit"));
const kits = computed(() => items.value.filter((e) => e.kind === "kit"));

type Tab = "gear" | "kits";
const tab = ref<Tab>("gear");
const tabs = computed(() => [
  { key: "gear", label: "Gear", icon: IconBackpack },
  ...(kits.value.length
    ? [{ key: "kits", label: "Kits", icon: IconToolbox }]
    : []),
]);
const sections = computed(() => vaultSections(pieces.value, false));
const kitNames = computed(() => new Map(kits.value.map((k) => [k.id, k.name])));
const inKits = (e: VaultEntry) =>
  e.inKits
    ?.map((id) => kitNames.value.get(id))
    .filter(Boolean)
    .join(", ") || undefined;
// a kit's part as a row: the part carries its own name and weight (the piece may not be
// on the page at all, a bar in a snack kit), shaped the way the row reads gear
const partEntry = (
  p: NonNullable<VaultEntry["parts"]>[number],
): VaultEntry => ({
  id: p.id,
  normKey: "",
  brand: p.brand,
  name: p.name,
  variant: p.variant,
  weightMg: p.weightMg,
  timesSeen: 0,
  lastUsedAt: "",
  createdAt: "",
});
// grams, and each piece in the unit its owner picked for it; the reader's choice isn't
// kept, as on a shared list
const unit = ref<Unit>("g");

const title = computed(() => (data.value ? sharedGearTitle(data.value) : ""));
const summary = computed(() => (data.value ? sharedGearSummary(data.value) : ""));
useHead({
  title: () => (data.value ? `${title.value} — Mahonia` : "Mahonia"),
  meta: [{ name: "robots", content: "noindex" }],
});

// THE PREVIEW a pasted link unfurls into (iMessage, Slack): the page's own title, its
// counts as a sentence, and the card /og/g draws. Noindex still keeps the page out of
// search; these tags only feed previews. While the link is off, every getter is empty and
// the app's static site card stands, so a turned-off link advertises nothing.
const origin = useSiteOrigin();
const description = computed(() => (data.value ? `${title.value} on Mahonia: ${summary.value}.` : undefined));
useSeoMeta({
  description: () => description.value,
  ogTitle: () => (data.value ? title.value : undefined),
  ogDescription: () => description.value,
  ogType: "website",
  ogImage: () => (data.value ? `${origin}/og/g/${code.value}` : undefined),
  ogImageAlt: () => (data.value ? `${title.value}: ${summary.value}. On Mahonia.` : undefined),
  ogImageWidth: OG_IMAGE_WIDTH,
  ogImageHeight: OG_IMAGE_HEIGHT,
  ogImageType: () => (data.value ? "image/png" : undefined),
  twitterImage: () => (data.value ? `${origin}/og/g/${code.value}` : undefined),
});
</script>

<template>
  <div>
    <SiteTopbar compact>
      <NuxtLink to="/e" class="btn btn--link">Create a list</NuxtLink>
    </SiteTopbar>

    <main
      v-if="data"
      id="main-content"
      tabindex="-1"
      class="wrap page sharedgear"
    >
      <h1 class="t-title sharedgear__title">{{ title }}</h1>
      <div class="sharedgear__bar">
        <ModeBar
          v-if="tabs.length > 1"
          :modes="tabs"
          :current="tab"
          label="Shared gear view"
          @pick="(k) => (tab = k as Tab)"
        />
      </div>

      <template v-if="tab === 'gear'">
        <p class="t-muted sharedgear__count">{{ counted(pieces.length, "piece") }}</p>
        <VaultSection
          v-for="section in sections"
          :key="section.key"
          :label="section.label"
          :collapse-key="`shared-${section.key}`"
        >
          <VaultGearRow
            v-for="entry in section.entries"
            :key="entry.id"
            :entry="entry"
            :unit="unit"
            :in-kits="inKits(entry)"
            bare
          />
        </VaultSection>
        <p v-if="!pieces.length" class="t-muted sharedgear__none">
          No gear here yet.
        </p>
      </template>

      <template v-else>
        <VaultSection
          v-for="kit in kits"
          :key="kit.id"
          :label="kit.name"
          :collapse-key="`shared-kit-${kit.id}`"
        >
          <VaultGearRow
            v-for="part in kit.parts ?? []"
            :key="part.id"
            :entry="partEntry(part)"
            :unit="unit"
            :qty="part.qty"
            :marks="false"
            bare
          />
        </VaultSection>
      </template>
    </main>

    <!-- Nothing to show: the site's one-message page, in a missing list's words, with My
         Gear's own mark (the one its signed-out page wears) -->
    <MessagePage v-else :icon="IconSafeSimple">
      <p>This gear link is off, or was mistyped.</p>
    </MessagePage>
  </div>
</template>

<style scoped lang="scss">
.sharedgear__title {
  margin-bottom: var(--space-4);
}
.sharedgear__bar {
  margin-bottom: var(--space-4);
}
.sharedgear__count {
  margin-bottom: var(--space-2);
}
</style>
