<script setup lang="ts">
// CONTACT_EMAIL is auto-imported from app/utils/site.
//
// How Mahonia works, for the parts the page itself can't show: what the two links
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
        <p>
          How Mahonia works, for the parts the page itself can’t show you. Jump to
          <a href="#links">your links</a>, <a href="#weights">weights and the catalog</a>,
          <a href="#lighterpack">moving from LighterPack</a>,
          <a href="#trips">planning a trip</a>, <a href="#gear">My Gear</a> or
          <a href="#assistants">using an assistant</a>.
        </p>

        <!-- ================= Links ================= -->
        <h2 id="links" class="help__section">Your list and its links</h2>
        <p>
          A list needs no account. It’s saved to the server once its first item has a name or a
          weight, and from then on it has two links, both in the Sharing panel:
        </p>
        <ul>
          <li>
            <strong>The edit link</strong> lets anyone who holds it change the list. Keep it
            private, and keep it somewhere safe.
          </li>
          <li>
            <strong>The share link</strong> is read-only. Send it to anyone. It always shows the
            latest version, and it isn’t listed or indexed anywhere.
          </li>
        </ul>
        <p>
          Two people with the edit link can work on a list at the same time. Each sees the
          other’s changes within a few seconds, without reloading.
        </p>

        <h3>If a link gets out</h3>
        <p>
          “Replace edit link” in the Share tab makes a new edit link, and the old one stops
          working straight away. The share link can’t be replaced. If it reaches someone it
          shouldn’t, use “Duplicate this list” and delete the original: the copy has links of its
          own.
        </p>

        <h3>If you lose the edit link</h3>
        <p>
          This browser remembers every list it has opened, under “Your packs” in the editor. Clear
          the browser’s data, though, and a list with no account behind it opens only from its edit
          link. I can’t recover that for you, so save the link somewhere.
        </p>
        <p>
          Signing in is the safety net. The lists this browser made, and every list you make while
          signed in, are filed under your account and open on any device you sign in on. A list
          someone sent you is filed with “Add to your account” in the Share tab.
        </p>

        <h3>Undo, history and deleting</h3>
        <p>
          Removing a row or a folder offers an undo for a few seconds. “Recent changes” in the Share
          tab shows what changed, when, and who did it: you, someone else with the edit link, or an
          assistant. Mahonia also keeps the last few versions of every list, so if something goes
          missing that undo can’t bring back, email me.
        </p>
        <p>
          “Delete this list” removes it for everyone with either link, and the page can’t undo it.
          A list that never got past one item is cleared away after 30 days untouched; a list with
          two items or more never expires. The <NuxtLink to="/legal#privacy">privacy policy</NuxtLink>
          has the exact timings.
        </p>

        <h3>Packing</h3>
        <p>
          Switch the editor to Packing and the list becomes a checklist. Ticks are saved with the
          list, so everyone with the edit link sees what’s packed; the share link doesn’t show them.
          “Clear checks” resets them for the next trip.
        </p>

        <!-- ================= Weights ================= -->
        <h2 id="weights" class="help__section">Weights and the catalog</h2>
        <p>
          Start typing an item’s name and the catalog offers matching gear. Pick one and the row
          takes its brand, gear type and weight. Nearly every weight in the catalog was read off the
          maker’s own page, and each one records where it came from. A few were weighed by hand,
          and a few are marked “community”: weights other people typed, not yet checked.
        </p>
        <p>Some conventions, so that numbers compare fairly:</p>
        <ul>
          <li>
            Tents are listed at their packaged weight, stakes and bags included, never the lighter
            trail or minimum figure. A tent that could only be found at trail weight says “trail
            weight” beside its name.
          </li>
          <li>
            Food weighs what you carry, contents and pouch. A row only found at net weight says
            “net”, and a fuel canister’s “net fuel” is the gas alone.
          </li>
          <li>Trekking poles are per pair. Everything else is per one.</li>
        </ul>

        <h3>When a weight is wrong</h3>
        <p>
          Type over it. Your number wins on your list, and the row stays linked to the catalog. If
          it’s the catalog that’s wrong, the row then offers “suggest a fix”: give the right weight
          and, if you can, a link to the maker’s or a shop’s page. With a link from a known maker
          or shop, the fix changes the catalog for everyone straight away; without one, it waits
          for a source. Every change is logged on
          <NuxtLink to="/changes">Recent catalog changes</NuxtLink>.
        </p>

        <h3>Units and totals</h3>
        <ul>
          <li>
            Type a weight with its unit: <code>820 g</code>, <code>1.36 kg</code>,
            <code>32.5 oz</code> or <code>2 lb 3 oz</code>. That row keeps the unit you typed while
            the totals stay in the list’s unit, which you change by tapping the big total. A bare
            number uses the row’s own unit.
          </li>
          <li>
            <strong>Base</strong> is the pack without what gets used up. <strong>Worn</strong> is
            what’s on your body. <strong>Consumable</strong> is food, water and fuel.
            <strong>Carried</strong> is base and consumable together: the whole pack, nothing worn.
          </li>
          <li>
            Mark three pairs of socks as worn with one on your feet, and one pair counts as worn
            while two go in the pack.
          </li>
          <li>
            Food rows take calories, and the list adds them up, per day too once the trip has dates.
            Food picked from the catalog brings its calories when the catalog knows them.
          </li>
          <li>
            “Keyboard shortcuts” in the editor’s ⋯ menu has the rest, like nudging a weight with the
            arrow keys.
          </li>
        </ul>

        <!-- ================= LighterPack ================= -->
        <h2 id="lighterpack" class="help__section">Moving from LighterPack</h2>
        <p>
          “Import a list…” in the editor’s ⋯ menu takes a LighterPack share link, a CSV pasted or
          chosen as a file, or a Mahonia backup. Each import becomes a new list.
        </p>
        <ul>
          <li>
            From LighterPack come your categories, as folders, and each item’s name, description,
            quantity, weight in the unit you typed it, worn and consumable marks, and link.
          </li>
          <li>Prices don’t come across, and neither do the list’s own name and unit.</li>
          <li>
            A row whose name matches a catalog product word for word arrives linked to it, and the
            import says how many matched.
          </li>
          <li>A list holds up to 1,000 items in up to 50 folders.</li>
        </ul>

        <h3>Getting a list back out</h3>
        <p>
          The Export tab in Sharing has four formats: plain text or Markdown, copied for pasting
          into a message or a note; a CSV for a spreadsheet; and a JSON backup that keeps
          everything, from catalog links and ticks to days and the route. Import that file and the
          list comes back whole. The one thing it leaves out is your body weight, which never leaves
          your device.
        </p>
        <p>
          A share link has the same exports under its ⋯ menu, without the route and the ticks,
          which a share link never carries. Add <code>.md</code> to the end of a share link and you
          get the list as Markdown.
        </p>

        <!-- ================= Trips ================= -->
        <h2 id="trips" class="help__section">Planning a trip</h2>
        <p>The Trip tab plans the walk itself. It works from the list’s dates and trail.</p>
        <ul>
          <li>
            <strong>The trail</strong> goes in the list’s header, as a link or a map file. A link
            stays a link: Mahonia doesn’t open the page behind it, so type the distance yourself. A
            map file gives the route’s distance and the shape of its climb: GPX, KML, KMZ, TCX, FIT,
            GeoJSON or GeoRSS, up to 10 MB, and a Garmin export’s zip works too. It’s read in your
            browser and never uploaded; Mahonia keeps only the line the trail follows.
          </li>
          <li>
            <strong>Days</strong> follow the trip’s dates, and “Add a day” moves the end date. Type
            how far each day goes, or drag the camps along the map.
          </li>
          <li>
            <strong>Each day</strong> shows its distance, climb and descent, a walking time, its
            hours of daylight and the calories it burns. Mark water on the route and it also shows
            the day’s longest dry carry.
          </li>
          <li>
            <strong>People.</strong> “Add people” in the ⋯ menu names who’s coming, up to 12. Mark
            who carries each item and each person’s load is added up, worn things included.
          </li>
        </ul>

        <h3>Where the numbers come from</h3>
        <ul>
          <li>
            Walking time uses Tobler’s hiking function: pace follows the slope, and drops about 1%
            for every kilogram on your back. The pack gets lighter each day as the food goes, but not
            the water, which you refill. It counts walking only, with no breaks.
          </li>
          <li>
            Daylight is sunrise to sunset at the middle of the day’s route, worked out from its
            coordinates and the date. It isn’t a forecast and doesn’t allow for hills. It stands out
            when the walk leaves less than two hours of light to spare.
          </li>
          <li>
            Calories use your body weight if you give it, and are good to about 20% either way. Your
            weight is kept on this device only.
          </li>
          <li>
            Distance is in miles unless you pick kilometres. Climb follows it: feet with miles,
            metres with kilometres.
          </li>
        </ul>

        <h3>What a share link shows</h3>
        <p>
          Each day’s name, distance, climb and note, and the elevation profile. Never the map, the
          route line or your waypoints: a recorded track often starts where you parked, which is
          sometimes where you live.
        </p>
        <p>
          The map’s tiles come from OpenTopoMap. Each day’s “Forecast” link opens weather.gov in the
          US or yr.no elsewhere, and nothing is sent to either until you click it.
        </p>

        <!-- ================= My Gear ================= -->
        <h2 id="gear" class="help__section">My Gear and your account</h2>
        <p>
          Lists never need an account. <NuxtLink to="/gear">My Gear</NuxtLink> does: it’s the gear
          you own, kept once and offered on every list you make. Sign in with a passkey, or with a
          link emailed to you that works once, within 15 minutes. Asking for a link for a new
          address makes the account.
        </p>
        <ul>
          <li>
            My Gear fills itself. While you’re signed in, every named row with a weight or a
            catalog link is saved as you build, once per brand, name and variant. A list someone
            else made asks first: “Add this list’s gear to My Gear?”
          </li>
          <li>
            A kit is a set you pack together, like a stove, pot and lighter. It weighs its pieces
            plus whatever holds them, and goes onto a list as one group with its pieces under it.
            Save a group from a list with “Save to My Gear as a kit”, or make one under Kits in My
            Gear.
          </li>
          <li>
            “Remove” puts a piece away rather than deleting it, and lists that still carry it won’t
            bring it back. Add it again in My Gear to have it offered once more.
          </li>
          <li>
            “Download everything” on your account page downloads every list filed under your
            account, and all of My Gear.
          </li>
          <li>
            “Delete account” deletes your email, passkeys and My Gear for good. Your lists stay
            unless you tick “Delete my lists too”: they belong to their edit links, and any link
            you’ve shared keeps working.
          </li>
        </ul>

        <!-- ================= Assistants ================= -->
        <h2 id="assistants" class="help__section">From an assistant</h2>
        <p>
          Mahonia is also a connector. Add <code>https://mahonia.app/mcp</code> to an AI assistant
          that speaks MCP and you can ask it for what you want, in plain words. There’s nothing to
          install.
        </p>
        <p>
          With no sign-in, it can read a list from its share link, search the catalog, make a new
          list, and, given an edit link, change one in a single step: add, edit, move, group and
          remove rows, relink them to the catalog, and rename or reorder folders. A share link is
          the permission to read and an edit link the permission to change, exactly as they are for
          a person.
        </p>
        <p>
          Signed in, it can also find the lists filed under your account and change them without a
          link, and read or change My Gear. The first time it needs your account, it asks you to
          sign in to Mahonia and allow it. It stays connected until you disconnect it under
          “Assistant access” on your account page.
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
            and choose “Sign in when needed”. It reaches Claude Code too.
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
            <strong>ChatGPT</strong>: in Settings, turn on Developer mode, then add the address
            with “No Authentication”.
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
          A client that can’t sign in can carry a token instead. Make one on your account page
          under “Assistant access”, read only or read and change, and send it as an
          <code>Authorization: Bearer</code> header. It’s shown once, and lasts until you revoke it.
        </p>

        <h2 class="help__section">Still stuck?</h2>
        <p>
          Email <a :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>, or use “Send
          feedback…” in the editor’s ⋯ menu.
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* Sections are set apart by air, not a rule: the site's headings are all one size
   (.prose :is(h2, h3), main.scss) and its hairlines are rare, so the extra space above
   each h2 is what makes the h3s under it read as its parts. /legal draws a rule here
   for its two halves; six sections would be six lines. */
.help__section {
  margin-top: var(--space-7);
  scroll-margin-top: var(--space-5);
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
