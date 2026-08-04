<script setup lang="ts">
// The account, centred over whatever you were doing.
//
// Body and shell are both borrowed, deliberately: BaseModal owns the scrim, the rise,
// click-outside, Escape, the focus trap and focus restore, and AccountView is the same
// component /account renders. This file is the wiring between them and nothing else.
const { state, close } = useAccountModal();
// The dialog's accessible name tracks the same state its heading does — a screen
// reader announcing "Your account" over a sign-in form is the same mismatch.
const { signedIn } = useSession();
const label = computed(() => (signedIn.value ? "Your account" : "Sign in"));
</script>

<template>
  <BaseModal :open="state.open" :label="label" @close="close">
    <!-- `done` is the panel telling us its errand finished — a sign-in landed, or the
         account was deleted. In this mount that means close; on /account it means go
         somewhere, which is why the panel takes the mount as a prop. -->
    <AccountView in-modal @done="close" />
  </BaseModal>
</template>
