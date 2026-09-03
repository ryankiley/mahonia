// The one guarded localStorage write. A write can throw on quota or in private
// mode; every preference this app remembers (editor mode, body weight, vault
// answers, dismissed intros) has decided the same thing about that: the setting
// just doesn't outlive the session then, which is never worth failing the
// interaction over. This was the same try/catch pasted across seven files before
// it lived here. Nuxt auto-imports app/utils, so callers use remember(...) bare.
export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not worth reporting */
  }
}

/** The read side of remember(): the stored string, or null when there is none — or
 *  when storage is blocked, which the caller treats the same way (its default holds
 *  for this visit). The same try/catch was pasted at every read before this. */
export function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Drop a remembered value, with the same shrug on failure as remember(). */
export function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* not worth reporting */
  }
}
