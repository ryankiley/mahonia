import { ref } from "vue";

/**
 * The read-only link to My Gear (/g/{code}), as the list editor handles a list's links:
 * copying the link is the one act, and asking for a link is what makes one (a list's
 * draft is saved by the same click; gear sharing is turned on by it). Stopping is the
 * act that cuts people off, so it asks first, as replacing a list's edit link does.
 *
 * The page owns this rather than the panel, because the panel closes before the copy
 * finishes (the same order the editor's Sharing panel keeps) and an unmounted panel
 * would have nobody to say how it went.
 */
export function useVaultShare(flash: (msg: string) => void) {
  const { confirm, copyLink } = useDialogs();
  /** Whether the link is on: null until asked, so the panel offers no Stop sharing it
   *  can't stand behind. */
  const sharing = ref<boolean | null>(null);
  let code: string | null = null;
  const urlOf = (c: string) => `${location.origin}/g/${c}`;

  async function refresh() {
    try {
      code = (await $fetch<{ code: string | null }>("/api/vault/share")).code;
      sharing.value = !!code;
    } catch {
      // leave it unknown: the copy row still works, and turns it on if it's off
    }
  }

  async function setOn(on: boolean): Promise<string | null> {
    const res = await $fetch<{ ok: boolean; code?: string | null }>("/api/vault/share", {
      method: "POST",
      body: { on },
    });
    if (!res.ok) throw new Error("refused");
    code = res.code ?? null;
    sharing.value = !!code;
    return code;
  }

  function copy() {
    // the link as it is, or as this same click turns it on (copyLink starts the write
    // inside the click either way)
    const link = code
      ? urlOf(code)
      : setOn(true).then((c) => {
          if (!c) throw new Error("no code");
          return urlOf(c);
        });
    return copyLink(link, { flash, done: "Read-only link copied", title: "Read-only link" });
  }

  async function stop() {
    const ok = await confirm({
      title: "Stop sharing your gear?",
      message: "The link stops working for everyone you sent it to. Copying a link again makes a new one.",
      confirmLabel: "Stop sharing",
    });
    if (!ok) return;
    try {
      await setOn(false);
      flash("Stopped sharing your gear");
    } catch {
      flash("Couldn’t stop sharing. Try again.");
    }
  }

  return { sharing, refresh, copy, stop };
}
