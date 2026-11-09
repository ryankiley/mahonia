<script setup lang="ts">
// CONTACT_EMAIL is auto-imported from app/utils/site.
//
// How Mahonia works, for the parts the app itself can't show: what the two links
// are, where a weight comes from, what an import keeps, how the Trip tab gets its
// numbers, and how an assistant connects. It describes the MODEL, not the interface.
// A sentence about which menu holds what goes stale the week the menu moves; a
// sentence about what an edit link is stays true for years. Name a control only
// where there is no other way to find it, and by the label the app actually shows.
//
// Every claim here was read off the code that does it, not off the README or About,
// which had both drifted: the README said either link could be replaced and a delete
// undone well after the toast, and About promised a morning-by-morning pack weight the
// Trip tab doesn't show. Change the behavior, change the sentence.
//
// Short and plain, on purpose. No colon or dash setting up an elaboration, no tagline
// sentences, no "never X" pivots: they read as machine-written (Ryan's call, and
// tests/prose-dashes.test.ts holds the dash half of it).
useHead({
  title: "Help — Mahonia",
  meta: [
    {
      name: "description",
      content:
        "How Mahonia's links, weights, imports, trip planning and assistant connector work.",
    },
  ],
});
</script>

<template>
  <div>
    <SiteTopbar label="Help" />
    <main id="main-content" tabindex="-1" class="wrap page">
      <div class="prose">
        <h1 class="visually-hidden">Help</h1>

        <!-- ================= Links ================= -->
        <h2 id="links" class="help__section">Your list and its links</h2>
        <p>
          A list needs no account. Once its first item has a name or a weight, it’s saved and gets
          two links, both in the Sharing panel.
        </p>
        <ul>
          <li>
            <strong>The edit link</strong> lets anyone who holds it change the list. Keep it private
            and save it somewhere safe.
          </li>
          <li>
            <strong>The share link</strong> is read-only and always shows the latest version. It
            isn’t listed or indexed anywhere.
          </li>
        </ul>
        <p>Two people with the edit link can edit at once and see each other’s changes within seconds.</p>

        <h3>If a link gets out</h3>
        <p>
          “Replace edit link” in the Share tab makes a new edit link, and the old one stops working.
          The share link can’t be replaced, so if it reaches the wrong person, use “Duplicate this
          list”, which gives the copy new links, and delete the original.
        </p>

        <h3>If you lose the edit link</h3>
        <p>
          “Your packs” in the editor lists every list this browser has opened. If you clear the
          browser’s data, a list with no account behind it opens only from its edit link, and I can’t
          recover that.
        </p>
        <p>
          Signed in, the lists this browser made and every list you make are filed under your
          account, and open on any device you sign in on. To file a list someone sent you, use “Add
          to your account” in the Share tab.
        </p>

        <h3>Undo, history and deleting</h3>
        <p>
          Removing a row or folder can be undone for a few seconds. “Recent changes” in the Share tab
          lists each change with its time and who made it. Mahonia keeps the last few versions of
          every list, so if something is lost past undo, email me.
        </p>
        <p>
          “Delete this list” removes it for everyone and can’t be undone in the app. Only a list with
          one item or none is ever cleared automatically, after 30 days untouched. The
          <NuxtLink to="/legal#privacy">privacy policy</NuxtLink> has the details.
        </p>

        <h3>Packing</h3>
        <p>
          Packing turns the list into a checklist. Ticks are saved for everyone with the edit link,
          and the share link doesn’t show them. “Clear checks” resets them.
        </p>

        <!-- ================= Weights ================= -->
        <h2 id="weights" class="help__section">Weights and the catalog</h2>
        <p>
          As you type an item’s name, the catalog suggests matching gear, and picking one fills in
          its brand, type and weight. Nearly every catalog weight comes from the maker’s own page. A
          few were weighed by hand, and a few marked “community” were typed by other people and
          haven’t been checked yet.
        </p>
        <p>How some gear is weighed:</p>
        <ul>
          <li>
            Tents at their packaged weight, with stakes and bags, which is heavier than the trail or
            minimum figure. A tent found only at trail weight says “trail weight”.
          </li>
          <li>
            Food with its pouch. A row found only at net weight says “net”, and a canister’s “net
            fuel” is the gas alone.
          </li>
          <li>Trekking poles as a pair, and everything else as a single item.</li>
        </ul>

        <h3>When a weight is wrong</h3>
        <p>
          Type your own weight over it. Your list uses your number, and the row stays linked to the
          catalog. If the catalog is wrong, use “suggest a fix” on the row, ideally with a link to the
          maker’s or a shop’s page. A fix with a link from a known maker or shop updates the catalog
          for everyone at once, and any other fix to a checked weight waits for a source.
        </p>

        <h3>Units and totals</h3>
        <ul>
          <li>
            Type a weight with its unit, like <code>820 g</code> or <code>2 lb 3 oz</code>. The row
            keeps that unit while totals stay in the list’s unit, which you change by tapping the big
            total.
          </li>
          <li>
            <strong>Base</strong> is the pack without what gets used up. <strong>Worn</strong> is
            what’s on your body. <strong>Consumable</strong> is food, water and fuel.
            <strong>Carried</strong> is base plus consumable.
          </li>
          <li>A row can be partly worn, like one pair of socks out of three.</li>
          <li>Food rows take calories, totalled for the list and per day once the trip has dates.</li>
          <li>“Keyboard shortcuts” in the editor’s ⋯ menu lists the rest.</li>
        </ul>

        <!-- ================= LighterPack ================= -->
        <h2 id="lighterpack" class="help__section">Moving from LighterPack</h2>
        <p>
          “Import a list…” in the editor’s ⋯ menu takes a LighterPack share link, a CSV or a Mahonia
          backup, and makes a new list from it.
        </p>
        <ul>
          <li>
            Each LighterPack category becomes a folder, and each item keeps its name, description,
            quantity, weight and unit, worn and consumable marks, and link.
          </li>
          <li>Prices, the list’s name and its unit don’t come across.</li>
          <li>Rows that exactly match a catalog product arrive linked to it.</li>
          <li>A list holds up to 1,000 items in 50 folders.</li>
        </ul>

        <h3>Getting a list back out</h3>
        <p>
          The Export tab in Sharing copies the list as plain text or Markdown, or downloads it as a
          CSV or a JSON backup. The backup has everything except your body weight, and importing it
          restores the whole list. A share link offers the same exports in its ⋯ menu, without the
          route or ticks, and adding <code>.md</code> to its address gives you Markdown.
        </p>

        <!-- ================= Trips ================= -->
        <h2 id="trips" class="help__section">Planning a trip</h2>
        <p>The Trip tab works from the list’s dates and trail.</p>
        <ul>
          <li>
            Add the trail in the list’s header. Mahonia doesn’t open a linked page, so with a link you
            type the distance yourself. A map file (GPX, KML, KMZ, TCX, FIT, GeoJSON or GeoRSS, up to
            10 MB) gives the distance and climb. The file stays in your browser, and Mahonia keeps
            only the line the trail follows.
          </li>
          <li>
            The days follow the trip’s dates. Type how far each day goes, or drag the camps along the
            map.
          </li>
          <li>
            Each day shows its distance, climb and descent, walking time, daylight, calories and a
            link to the forecast. Marking water on the route adds the day’s longest dry carry.
          </li>
          <li>
            “Add people” in the ⋯ menu names who’s coming, up to 12. Each person’s load is the items
            marked as theirs, worn things included.
          </li>
        </ul>

        <h3>Where the numbers come from</h3>
        <ul>
          <li>
            Walking time uses Tobler’s hiking function, slowed about 1% per kilogram carried. The
            pack gets lighter each day as the food is eaten (water isn’t counted, since you refill
            it). Breaks aren’t included.
          </li>
          <li>
            Daylight is sunrise to sunset at the middle of the day’s route, without allowing for
            hills. It changes colour when the walk leaves less than two hours spare.
          </li>
          <li>
            Calories use your body weight if you give it, and are good to about 20%. Your weight stays
            on this device.
          </li>
          <li>Distance is in miles unless you pick kilometres. Climb is in feet or metres to match.</li>
        </ul>

        <h3>What a share link shows</h3>
        <p>
          A share link shows each day’s name, distance, climb and note, and the elevation profile. It
          leaves out the map, the route line and your waypoints, because a recorded track can start
          where you live.
        </p>

        <!-- ================= My Gear ================= -->
        <h2 id="gear" class="help__section">My Gear and your account</h2>
        <p>
          <NuxtLink to="/gear">My Gear</NuxtLink> keeps the gear you own and offers it on every list
          you make. It needs an account. Sign in with a passkey or an emailed link, which works once
          within 15 minutes, and a new address gets an account the first time it asks for a link.
        </p>
        <ul>
          <li>
            While you’re signed in, My Gear saves each named row that has a weight or a catalog link
            as you build. On someone else’s list, it asks first.
          </li>
          <li>
            A kit is a set you pack together, like a stove, pot and lighter, and goes onto a list as
            one group. Make one under Kits in My Gear, or save a list’s group with “Save to My Gear as
            a kit”.
          </li>
          <li>
            “Remove” puts a piece away, and lists that still carry it won’t bring it back. Adding it
            again in My Gear does.
          </li>
          <li>“Download everything” on your account page downloads your filed lists and My Gear.</li>
          <li>
            “Delete account” erases your email, passkeys and My Gear. Your lists stay, with their
            links, unless you tick “Delete my lists too”.
          </li>
        </ul>

        <!-- ================= Assistants ================= -->
        <h2 id="assistants" class="help__section">From an assistant</h2>
        <p>
          Mahonia is also a connector. Add <code>https://mahonia.app/mcp</code> to an AI assistant
          that speaks MCP, and you can ask it to work on your lists. Without signing in, it can read a
          list from its share link, search the catalog, make a list, and change one given its edit
          link, with the same permissions those links give a person.
        </p>
        <p>
          Signed in, it can also reach the lists filed under your account, and My Gear. It asks you
          to sign in the first time, and stays connected until you disconnect it under “Assistant
          access” on your account page.
        </p>

        <h3>Setting it up</h3>
        <ul>
          <li>
            <strong>Claude</strong>, on the web, desktop or phone:
            <a
              href="https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Mahonia&connectorUrl=https%3A%2F%2Fmahonia.app%2Fmcp"
              target="_blank"
              rel="noopener noreferrer"
              >add Mahonia as a connector</a
            >
            and choose “Sign in when needed”. It works in Claude Code too.
          </li>
          <li>
            <strong>Cursor</strong> and <strong>VS Code</strong>: one click, for
            <a
              href="https://cursor.com/install-mcp?name=mahonia&config=eyJ1cmwiOiJodHRwczovL21haG9uaWEuYXBwL21jcCJ9"
              target="_blank"
              rel="noopener noreferrer"
              >Cursor</a
            >
            or
            <a
              href="https://insiders.vscode.dev/redirect/mcp/install?name=mahonia&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmahonia.app%2Fmcp%22%7D"
              target="_blank"
              rel="noopener noreferrer"
              >VS Code</a
            >.
          </li>
          <li>
            <strong>ChatGPT</strong>: in Settings, turn on Developer mode and add the address with
            “No Authentication”.
          </li>
          <li>
            <strong>Claude Code</strong>:
            <code class="help__cmd" tabindex="0"
              >claude mcp add --transport http --scope user mahonia https://mahonia.app/mcp</code
            >
          </li>
          <li>
            <strong>Gemini CLI</strong>:
            <code class="help__cmd" tabindex="0"
              >gemini mcp add --transport http mahonia https://mahonia.app/mcp</code
            >
          </li>
          <li>
            <strong>Anything else</strong> takes the address. A client that only speaks stdio can
            bridge to it:
            <code class="help__cmd" tabindex="0">npx mcp-remote https://mahonia.app/mcp</code>
          </li>
        </ul>
        <p>
          A client that can’t sign in can use a token instead. Make one under “Assistant access” on
          your account page and send it as an <code>Authorization: Bearer</code> header. It’s shown
          once and lasts until you revoke it.
        </p>

        <h2 class="help__section">Questions?</h2>
        <p>
          Email <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>, or use “Send
          feedback…” in the editor’s ⋯ menu.
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* Every heading gets the same space above it, h2 or h3: the site's headings are all
   one size (.prose :is(h2, h3), main.scss), so a bigger gap above the h2s didn't read
   as hierarchy. It read as uneven spacing (Ryan, 2026-11-09), and it went. The h2/h3
   split stays for the outline a screen reader walks. */
.help__section {
  scroll-margin-top: var(--space-5);
}
/* The page opens on its first section. The hidden h1 sits before it, so the global
   :first-child reset never reaches this h2, and without this it would start lower
   than /about's first line does. */
.help__section:first-of-type {
  margin-top: 0;
}
/* A command to paste, on a line of its own. The prose chip (.prose code) wraps
   anywhere, which is right for an address in a sentence and wrong for a command: on a
   phone it split "--scope" after its dashes. One line that scrolls inside its own box
   instead, and tabindex on the element so a keyboard can scroll it too. */
.help__cmd {
  display: block;
  width: fit-content;
  margin-top: var(--space-1);
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
}
</style>
