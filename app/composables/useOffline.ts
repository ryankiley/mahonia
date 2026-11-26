// OFFLINE, as far as this tab can tell, for chrome that should say so before anyone
// presses anything that needs the network.
//
// Two witnesses, either one enough. The browser (navigator.onLine): right when it says
// offline, but it goes on saying online through a dead trailhead connection or a captive
// portal. And the open list's own sync (useGearList's "offline" status, told here by
// SyncStatus): the thing that has actually just tried the server and failed. The
// account control reads this to swap its glyph for a cloud with a line through it, and
// says the rest when pressed.
export function useOffline(): ComputedRef<boolean> {
  const online = useOnline();
  const sync = useSyncOffline();
  return computed(() => !online.value || sync.value !== null);
}

/** What the open list's sync says about being offline: null while it can reach the
 *  server (or there is no list open), "saved" when it can't and the list is on this
 *  device, "unsaved" when it can't and nothing is. Set by SyncStatus, which is mounted
 *  exactly as long as there is a list to speak for. Per request on the server
 *  (useState), where it is always null. */
export type SyncOffline = "saved" | "unsaved" | null;
export const useSyncOffline = () => useState<SyncOffline>("sync-offline", () => null);
