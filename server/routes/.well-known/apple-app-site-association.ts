import { defineEventHandler, setHeader } from "h3";

// Apple App Site Association — what lets the native iOS app
// (github.com/ryankiley/mahonia-ios) claim this domain's links.
//
// Two grants, one file:
//
//   applinks — universal links. /e, /s and /l open in the app when it's
//   installed. The EDIT capability rides the URL fragment (/e/{code}#{token}),
//   and iOS hands the app the full URL including the fragment via
//   NSUserActivity.webpageURL — the fragment never reaches this server, same
//   as in a browser, so the no-login capability model carries over intact.
//
//   webcredentials — passkeys. Lets the app run the SAME WebAuthn ceremonies
//   the site uses (server/utils/passkeys.ts): the RP ID is derived from the
//   request host, and Apple reports the app's origin as https://mahonia.app,
//   so the existing verify endpoints work unchanged.
//
// Served as application/json with NO redirect and NO extension — Apple's CDN
// fetches this path exactly and refuses redirects. The appID prefix is the
// Apple Developer Team ID.
const APP_ID = "P4N85D2689.com.ryankiley.mahonia";

export default defineEventHandler((event) => {
  setHeader(event, "Content-Type", "application/json");
  // Apple's CDN re-fetches on its own cadence (hours-to-a-day); a day of edge
  // cache costs nothing and keeps the path off the lambda.
  setHeader(event, "Cache-Control", "public, max-age=0, s-maxage=86400");
  return {
    applinks: {
      apps: [],
      details: [
        {
          appID: APP_ID,
          // The three list surfaces only. Everything else (about, legal,
          // vault, auth callbacks) stays in the browser, where it belongs.
          paths: ["/e", "/e/*", "/s/*", "/l/*"],
        },
      ],
    },
    webcredentials: {
      apps: [APP_ID],
    },
  };
});
