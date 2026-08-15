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
