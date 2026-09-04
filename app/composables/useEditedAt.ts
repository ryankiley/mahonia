import type { Ref } from "vue";

// The list's LAST-EDIT moment as a timestamp, plus the clock that ages it — the one
// derivation behind the editor's SyncStatus suffix ("edited 1 hour ago") and the
// read views' meta line, so a share link and its editor phrase freshness from the
// same instant and re-render on the same 30s tick (finer than the smallest "N
// minutes" step, so "just now" → "1 minute ago" flips promptly without a
// per-second churn). Null when there is no server write yet (a never-saved draft)
// or the stamp doesn't parse — a caller shows nothing rather than "Invalid Date".
export function useEditedAt(updatedAt: () => string | undefined): {
  editedAt: Ref<number | null>;
  now: Ref<Date>;
} {
  const now = useNow({ interval: 30_000 });
  const editedAt = computed(() => {
    const iso = updatedAt();
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : null;
  });
  return { editedAt, now };
}
