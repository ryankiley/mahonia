// The two per-account memos this device keeps outside the session — "already sent
// gear to the vault" (useVault) and "already claimed these lists" (useClaimedLists).
// Every way an account ends on this device (sign out, sign out everywhere, delete)
// has to drop both, so the next person to sign in here starts clean rather than
// inheriting "already sent" / "already claimed". One call, so a fourth exit can't
// forget one of them.
export function clearAccountMemos(): void {
  resetVaultCapture();
  useClaimedLists().resetClaimMark();
}
