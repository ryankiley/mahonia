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
export default defineNuxtPlugin(() => {
  const session = useSession();
  // not awaited: nothing on first paint depends on it, and blocking hydration on
  // a session lookup would trade a real cost for no visible benefit
  void session.refresh();

  // Attach the lists this browser holds to the account, so they're waiting on the
  // next device.
  //
  // Driven by a WATCHER, not by the refresh above: signing in usually happens
  // mid-session (the magic link is redeemed in this same tab, and /auth/callback
  // re-reads the session without reloading the app), so a one-shot call at plugin
  // boot would miss the exact moment it matters most. The watcher covers both —
  // an already-signed-in cold load, and a sign-in that happens later.
  //
  // Fingerprinted inside claimDeviceLists, so a signed-in visitor whose registry
  // hasn't changed makes no request at all.
  // Nothing equivalent is needed for the vault: it belongs to the account
  // already, so signing in on a new device simply finds it. That claim-on-sign-in
  // step only existed while a vault was owned by a link the browser happened to
  // hold.
  watch(session.signedIn, (yes) => {
    if (!yes) return;
    void useClaimedLists().claimDeviceLists();
  });
});
