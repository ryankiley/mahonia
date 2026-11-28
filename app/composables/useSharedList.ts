import type { Ref } from "vue";
import type { ListSnapshot } from "~~/shared/types";

/**
 * What a share link has to show: the list, or why there is none.
 *
 * `keptAt` marks the list as this device's copy (app/utils/sharedListCopy.ts), shown
 * because the server couldn't be reached. Without a list, `missing` says which of three
 * things happened, and they are not the same thing to a reader: the server says the
 * list is gone; the server couldn't be reached and this device holds no copy; or the
 * server answered with a failure.
 */
export type SharedList =
  | { snapshot: ListSnapshot; keptAt?: number }
  | { snapshot: null; missing: "gone" | "offline" | "failed" };

/**
 * The list behind a share link (/s/{code}), for the page.
 *
 * With a connection this is the server's answer and nothing else: rendered on the
 * server and carried in the page, as it always was. In the browser the answer is also
 * kept on the device, so that the same link opens with no connection, where the page
 * arrives as the service worker's client-only shell (config/pwa.ts) and asks for the
 * list itself. A copy stands in only when the server gave no answer at all or a
 * failure, never for a 404, which drops it: a deleted list, or one whose link was
 * changed, must not go on opening from a device that once saw it.
 *
 * `loaded` is the first answer; the page awaits it.
 */
export function useSharedList(code: Ref<string>) {
  // the request's own fetch on the server, so the read is made in-process and as the
  // visitor (their address is what the read is rate-limited by)
  const ask = useRequestFetch();
  // without the offline shell nothing could open a copy, so none is kept or read
  const keeps = import.meta.client && useOfflineEnabled();

  const asyncData = useAsyncData<SharedList>(
    () => `shared-list:${code.value}`,
    async () => {
      try {
        const { snapshot } = await ask<{ snapshot: ListSnapshot }>(`/api/s/${code.value}`);
        return { snapshot };
      } catch (e) {
        const status = statusOf(e);
        if (status === 404 || status === 410) return { snapshot: null, missing: "gone" };
        const copy = keeps ? await readSharedList(code.value) : null;
        if (copy) return copy;
        // no status is no answer: the request never reached the server
        return { snapshot: null, missing: import.meta.client && status === undefined ? "offline" : "failed" };
      }
    },
  );
  const shared = asyncData.data;

  if (keeps) {
    // What the device holds follows what the server last said. Kept once the page is
    // up and the browser idle: a list is a few hundred KB to write at its largest.
    watch(
      shared,
      (now) => {
        if (!now) return;
        const { snapshot } = now;
        if (snapshot && now.keptAt === undefined) onNuxtReady(() => void keepSharedList(snapshot));
        else if (!snapshot && now.missing === "gone") void dropSharedList(code.value);
      },
      { immediate: true },
    );
  }
  // Ask again while the answer is a stand-in or a failure, so the page opens the list
  // (or trades the copy for it) once the connection is back, as the editor does.
  const unanswered = computed(() => {
    const now = shared.value;
    return !!now && (now.snapshot ? now.keptAt !== undefined : now.missing !== "gone");
  });
  useRetryWhile(unanswered, () => void asyncData.refresh());

  return { shared, loaded: asyncData.then(() => undefined) };
}
