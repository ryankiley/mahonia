<template>
  <!-- Column shell so the footer sits at the bottom on short pages (legal/404)
       and below the content on long ones. Auto-applied to every page. -->
  <div class="shell">
    <div class="shell__main">
      <slot />
    </div>
    <SiteFooter />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100svh;
}
.shell__main {
  flex: 1 0 auto;
}
</style>
