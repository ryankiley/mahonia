<script setup lang="ts">
// /authorize — the connector's sign-in and consent page, where Claude (or any OAuth
// client) sends a person so their assistant can reach My Gear.
//
// Two states on one page, decided by the session. Signed out, it is the same sign-in
// form the account dialog shows, set inline as a step, and a finished sign-in stays
// here; the page simply re-renders as the consent
// once there is an account. Signed in, it names the app asking and what it wants,
// and Allow or Deny sends the person back to the app with the answer.
//
// The request in the URL is checked by the server (/api/oauth/authorize) before
// anything is shown, so a client that isn't one, or a redirect that isn't the
// client's, gets a page that says so and never a redirect. Everything else about a
// bad request goes back to the client as the error it asked to receive.
//
// Opened in a popup by Claude's apps, and by a terminal client's browser for Claude
// Code; in both the magic-link sign-in may finish in ANOTHER tab, because the link is
// clicked from a mail app. Two things cover that: the return path is remembered so
// the tab the link opens lands here too, and this tab looks for the session's hint
// cookie every few seconds while signed out — a cookie read, nothing more, until the
// other tab has set it — so it moves on to the consent the moment that happens. The
// window Claude is watching is this one.
import { IconCirclePlus, IconExclamationTriangle, IconEyeOpen, IconPencil2 } from "~/icons/central";
import { SvgIcon } from "~/utils/icon";
import type { IconNode } from "~/utils/icon";
import { clientMark, type AskingClient, type ReturnTo } from "~/utils/clientMark";
import type { AccessScope } from "~~/shared/types";

useHead({
  title: "Connect — Mahonia",
  // no footer: About and Legal are two ways out of a page whose only exits should be
  // Allow and Deny. The layout hides it for a body marked `bare` (layouts/default.vue).
  // A body class and not definePageMeta: page meta goes into the route table in the
  // entry chunk every visitor downloads, and that first load sits at its ceiling.
  bodyAttrs: { class: "bare" },
  meta: [{ name: "robots", content: "noindex" }],
});

const route = useRoute();
const { signedIn, presence, hasSessionHint, refresh } = useSession();

type Checked =
  | { ok: true; client: AskingClient; level: AccessScope; returnTo: ReturnTo }
  | { ok: false; error: string; description: string; redirect: string | null };
const { data: checked } = await useFetch<Checked>("/api/oauth/authorize", { query: route.query, key: `authorize:${route.fullPath}` });

// A request the client should hear about goes back to it as an error, by a link the
// person clicks and never a bounce: no request proves its redirect is one this page may
// follow unasked (the GET says why), so mahonia.app is never a hop to wherever a crafted
// URL says.
const errorBack = computed(() => (checked.value && !checked.value.ok && checked.value.redirect ? { href: checked.value.redirect, host: new URL(checked.value.redirect).host } : null));

const writes = computed(() => checked.value?.ok && checked.value.level === "write");
const wants = computed(() =>
  writes.value
    ? "see and change what’s in My Gear and your lists, and add new lists to your account"
    : "see what’s in My Gear and your lists",
);
// The same grant as `wants`, one row per thing it can do, each marked by the ACTION
// rather than the thing: the eye and the pencil are the account page's own marks for a
// read-only and a read-and-change token, so a read-only grant reads as two eyes at a
// glance, and the text already says whether it's My Gear or the lists.
// Read-and-change can do everything read can.
const scopes = computed<{ icon: IconNode; text: string }[]>(() =>
  writes.value
    ? [
        { icon: IconEyeOpen, text: "See what’s in My Gear" },
        { icon: IconPencil2, text: "Change what’s in My Gear" },
        { icon: IconEyeOpen, text: "See your lists" },
        { icon: IconPencil2, text: "Change your lists" },
        { icon: IconCirclePlus, text: "Add new lists to your account" },
      ]
    : [
        { icon: IconEyeOpen, text: "See what’s in My Gear" },
        { icon: IconEyeOpen, text: "See your lists" },
      ],
);
// Who is asking, as the page names and draws them: a logo and our own name for it only
// on a host the server has checked, the app's own name and its initial otherwise
// (utils/clientMark says which is which, and why).
const mark = computed(() => (checked.value?.ok ? clientMark(checked.value.client, checked.value.returnTo) : null));
const label = computed(() => mark.value?.name ?? "");

onMounted(() => {
  refresh();
  // the tab an emailed link opens comes back to this exact request
  useReturnTo().remember(route.fullPath);
});
// while signed out, look for the hint cookie every few seconds and re-read the
// session only once it is there: an idle tick costs a cookie read and nothing else
let poll: ReturnType<typeof setInterval> | undefined;
watch(
  signedIn,
  (on) => {
    if (poll) clearInterval(poll);
    poll = undefined;
    if (!on && import.meta.client) {
      poll = setInterval(() => {
        if (document.visibilityState === "visible" && hasSessionHint()) refresh(true);
      }, 3_000);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => poll && clearInterval(poll));

const deciding = ref(false);
const note = ref("");
async function decide(decision: "allow" | "deny") {
  if (deciding.value) return;
  deciding.value = true;
  note.value = "";
  try {
    const res = await $fetch<{ ok: boolean; redirect?: string | null; description?: string }>("/api/oauth/authorize", {
      method: "POST",
      body: { ...route.query, decision },
    });
    if (res.redirect) {
      note.value = `Sending you back to ${checked.value?.ok ? checked.value.returnTo.host : "the app"}…`;
      window.location.assign(res.redirect);
      return;
    }
    note.value = res.description ?? "That didn’t work. Try again.";
  } catch {
    note.value = "Couldn’t send your answer. Check your connection and try again.";
  }
  deciding.value = false;
}
</script>

<template>
  <div>
    <SiteTopbar />
    <main id="main-content" tabindex="-1" class="wrap page">
      <!-- one narrow column in the middle: the page is a single decision, and in the
           popup Claude opens it in, the column is simply the window -->
      <div class="az">
        <!-- a request that failed: say so, and offer the way back when there is one -->
        <template v-if="checked && !checked.ok">
          <h1 class="t-title">This connection can’t be made</h1>
          <p class="t-muted">{{ checked.description }}</p>
          <p class="t-muted">Nothing was changed on your account. Try adding the connector again from the app that sent you here.</p>
          <a v-if="errorBack" :href="errorBack.href" class="btn btn--ghost az__deny az__back">Return to {{ errorBack.host }}</a>
        </template>

        <template v-else-if="checked">
          <!-- the two parties, side by side: the app asking, and Mahonia -->
          <div class="az__marks" aria-hidden="true">
            <span class="az__tile">
              <SvgIcon v-if="mark?.icon" :icon="mark.icon" size="xl" />
              <span v-else class="az__initial">{{ mark?.initial }}</span>
            </span>
            <span class="az__tie" />
            <span class="az__tile">
              <!-- the favicon's M, in the page's foreground -->
              <MahoniaMark class="az__home" />
            </span>
          </div>
          <!-- One heading per state, inside ClientOnly with the state it names. Signed
               out there is nothing to allow yet, so it says what the sign-in is for;
               signed in it is the consent's own lead-in, the words the Allow button
               finishes. -->
          <ClientOnly>
            <!-- SIGNED OUT: the account surface, exactly as the modal mounts it, so a
                 sign-in finishes here rather than leaving for /gear -->
            <template v-if="presence === 'signedOut'">
              <h1 class="t-title">Connect {{ label }} to Mahonia</h1>
              <p class="t-muted">Sign in to your Mahonia account first. {{ label }} will then ask to {{ wants }}.</p>
              <div class="az__signin">
                <AccountView as-step />
              </div>
            </template>

            <!-- SIGNED IN: the consent -->
            <template v-else-if="signedIn">
              <section class="az__ask">
                <h1 class="t-title">Allow {{ label }} to:</h1>
                <ul class="az__scopes">
                  <li v-for="s in scopes" :key="s.text" class="az__scope">
                    <SvgIcon :icon="s.icon" :stroke-width="1.25" class="az__scopeicon" aria-hidden="true" />
                    <span>{{ s.text }}</span>
                  </li>
                </ul>
                <p class="t-muted az__fine">Until you disconnect it in your account, under Assistant access.</p>
              </section>

              <!-- what Mahonia couldn't check, said before the buttons rather than under them -->
              <div v-if="checked.returnTo.loopback || !mark?.checked" class="az__caution">
                <SvgIcon :icon="IconExclamationTriangle" class="az__cautionicon" aria-hidden="true" />
                <!-- one short paragraph, whichever of the two applies -->
                <p>
                  <template v-if="!mark?.checked">Mahonia can’t confirm who made this app. </template>
                  <template v-if="checked.returnTo.loopback">
                    Any program on this computer could be listening at <code>{{ checked.returnTo.host }}</code>, so only allow
                    this if you just started {{ label }} yourself.
                  </template>
                </p>
              </div>

              <!-- who is signed in is the topbar's account disc, and its menu signs out:
                   the page doesn't say it a second time -->
              <div class="az__actions">
                <button type="button" class="btn az__deny" :disabled="deciding" @click="decide('deny')">Deny</button>
                <button type="button" class="btn btn--primary" :disabled="deciding" @click="decide('allow')">Allow</button>
              </div>

              <p v-if="note" class="az__note" role="status">{{ note }}</p>
              <!-- where Allow or Deny takes you; a loopback address is named in the caution -->
              <p v-else-if="!checked.returnTo.loopback" class="t-muted az__fine">You’ll go back to {{ checked.returnTo.host }}.</p>
            </template>

            <template v-else>
              <h1 class="t-title">Connect {{ label }} to Mahonia</h1>
              <p class="t-muted">Loading…</p>
            </template>
            <template #fallback>
              <h1 class="t-title">Connect {{ label }} to Mahonia</h1>
              <p class="t-muted">Loading…</p>
            </template>
          </ClientOnly>
        </template>

        <p v-else class="t-muted">Loading…</p>
      </div>
    </main>
  </div>
</template>

<style scoped lang="scss">
.az {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
  max-width: var(--account-measure);
  margin-inline: auto;
  /* the topbar is the page's only other furniture, so the column sits a clear step
     below it on a wide window rather than tucked against it */
  padding-top: var(--space-7);
}
@media (max-width: $bp-stack) {
  .az {
    padding-top: var(--space-4);
  }
}

/* ---- the two parties ---- */
.az__marks {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.az__tile {
  display: grid;
  place-items: center;
  width: calc(48 * var(--tpx));
  height: calc(48 * var(--tpx));
  border-radius: var(--radius-3);
  background: var(--background-secondary);
  color: var(--foreground-primary);
}
.az__initial {
  font-size: var(--text-title);
  font-weight: var(--font-weight-semibold);
  line-height: var(--leading-none);
}
.az__home {
  width: calc(22 * var(--tpx));
  height: calc(22 * var(--tpx));
}
/* the tie between them: three dots of the quietest foreground, drawn as one dotted rule so
   the gap reads as a connection being made rather than a gap */
.az__tie {
  width: var(--space-6);
  height: 0;
  border-top: 3px dotted var(--foreground-tertiary);
}

/* ---- what it asks for ---- */
/* the heading sits in here now, so no nudge above it: it lands where the signed-out
   heading does, and the switch from sign-in to consent doesn't move it */
.az__ask {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.az__scopes {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-primary);
}
.az__scope {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding-block: var(--space-3);
  border-bottom: 1px solid var(--border-primary);
}
.az__scopeicon {
  flex: none;
  /* centred on the first line of the text beside it: (1.5em line − the glyph) / 2 */
  margin-top: calc((1lh - var(--icon)) / 2);
  color: var(--foreground-secondary);
}

/* ---- what Mahonia couldn't check ---- */
.az__caution {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-2);
  background: var(--background-secondary);
}
.az__cautionicon {
  flex: none;
  margin-top: calc((1lh - var(--icon)) / 2);
}

/* ---- the decision ---- */
/* two equal halves, the quiet answer first and the filled one where the hand ends —
   the order every dialog in the app uses */
.az__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin-top: var(--space-2);
  gap: var(--space-3);
}
.az__deny {
  border: 1px solid var(--border-strong);
}
.az__back {
  align-self: flex-start;
  margin-top: var(--space-2);
}
.az__note {
  color: var(--foreground-primary);
}
.az__fine {
  font-size: var(--text-chrome);
}

.az__signin {
  width: 100%;
}
</style>
