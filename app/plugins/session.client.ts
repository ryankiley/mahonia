// Resolve the signed-in user once per page load, app-wide.
//
// The vault's two live surfaces are NOT the vault page: gear is captured from the
// editor, and your own gear is offered in the item autocomplete. Both need to know
// whether someone is signed in, and neither would ever call /api/auth/me on its
// own — before this plugin existed, capture silently did nothing on /e because
// `signedIn` was still false there.
//
// Costs nothing for visitors without an account: refresh() short-circuits on the
// absence of the readable hint cookie, so it makes NO request unless there's
// plausibly a session to fetch. That matters here more than it usually would —
// `/e` is prerendered and CDN-served with zero function invocations, and it's the
// route the whole site redirects to.
import { deviceFingerprint } from "~/composables/useClaimedLists";

export default defineNuxtPlugin(() => {
  const session = useSession();
  // What an earlier session left in this browser's storage and nobody was here to
  // forget. Before anything below reads what the current one kept.
  sweepStaleOwned(session.hasSessionHint());
  // What this browser last knew of the account's lists, before anything asks the
  // server — and the cross-tab follow that keeps it honest. See restoreFromDevice.
  useClaimedLists().restoreFromDevice();
  // not awaited: nothing on first paint depends on it, and blocking hydration on
  // a session lookup would trade a real cost for no visible benefit
  void session.refresh();
  // ...and again while it can't be answered (offline with an account), for every
  // surface waiting on it at once
  useSessionReask();

  // Attach the lists this browser holds to the account, so they're waiting on the
  // next device.
  //
  // Driven by a WATCHER, not by the refresh above: signing in usually happens
  // mid-session (the magic link is redeemed in this same tab, and /auth/callback
  // re-reads the session without reloading the app), so a one-shot call at plugin
  // boot would miss the exact moment it matters most.
  //
  // The REGISTRY is the second source, and it's what makes a list made mid-session
  // reach the account while the tab is still open. Claiming used
  // to happen only at page load — a desktop tab that stays up for days built lists
  // the account never heard about, and the phone's switcher (which reads the
  // account) couldn't show them however often it refreshed. The fingerprint is the
  // same one claimDeviceLists marks in localStorage — computed once here and handed
  // through — so a signed-in visitor whose registry hasn't changed still makes no
  // request at all.
  //
  // Nothing equivalent is needed for the vault: it belongs to the account
  // already, so signing in on a new device simply finds it. That claim-on-sign-in
  // step only existed while a vault was owned by a link the browser happened to
  // hold.
  const registryFingerprint = computed(() =>
    // the whole registry — the same set the claim sends, both buckets
    deviceFingerprint(useMyLists().entries.value.map((e) => e.editToken)),
  );
  // On the OWNER, not on signedIn: an account replaced by another in this browser
  // (B's sign-in link redeemed while A was in) never flips signedIn, and the
  // switcher kept A's lists until a reload.
  //
  // And on `sweep`: a sign-in someone only confirmed here doesn't bring the
  // browser's lists until they say so (claimDeviceLists holds the gate), and the
  // yes arrives as that flag turning true on a session already signed in.
  watch(
    [() => session.user.value?.owner, registryFingerprint, () => session.user.value?.sweep],
    ([owner, fingerprint]) => {
      if (!owner) return;
      void useClaimedLists().claimDeviceLists(fingerprint);
    },
  );
});
