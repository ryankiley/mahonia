<script setup lang="ts">
import { SvgIcon, type IconNode } from "~/utils/icon";

// A PAGE THAT IS ONE MESSAGE AND ONE WAY ON: the 404, a shared list that isn't there, a
// gear link that's off. One block, written once, so the three can't drift apart the way
// they did when each built its own (two sat top-left while the 404 sat centred).
//
// Centred both ways between the top bar and the footer by .page--alone + .prose
// (main.scss), with the mark an empty state wears over the message (.page__mark): what
// kind of page this is, before the words say it. The words are the default slot. The way
// on is "Create a list" unless a page names its own (the error page clears the error on
// the way out); anything after it, such as the dev-only stack, goes in `after`.
defineProps<{ icon: IconNode }>();
</script>

<template>
  <main id="main-content" tabindex="-1" class="wrap page page--alone">
    <div class="prose">
      <SvgIcon :icon="icon" size="xl" class="page__mark" aria-hidden="true" />
      <slot />
      <p>
        <slot name="action">
          <NuxtLink to="/e" class="btn btn--primary">Create a list</NuxtLink>
        </slot>
      </p>
      <slot name="after" />
    </div>
  </main>
</template>
