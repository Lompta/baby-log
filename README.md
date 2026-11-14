# Baby Log

A small, private, shared log for a new baby's feedings and diapers. Built to live as a home-screen app on a few phones (parents, grandparents, a nanny) that all see the same data.

- **Nursing** with a left/right start-stop timer, plus an optional "how heavy it seemed" (light / medium / heavy)
- **Bottles** in ounces, with milk type (breast milk / formula / hybrid) and a Vitamin D drops checkbox
- **Diapers** (wet / dirty / both) on a separate tab
- A "last fed" clock, a day timeline, a week view with daily averages, and CSV export
- Works offline; edits sync between phones every 15 seconds, newest edit wins per entry
- Anyone allowed in can add, edit, or delete anything (with undo)

It runs on Cloudflare's free tier: a single Worker serves the page and stores the data in a Durable Object. Cloudflare Access (also free for up to 50 users) handles sign-in, so only the people you list can reach it at all. No build step and no dependencies.

## What you need

- A Cloudflare account with a domain on it (any domain; the app gets a subdomain like `baby.yourdomain.com`)
- Node.js, for running `npx wrangler`

## Setup (about 15 minutes)

1. **Turn on Zero Trust.** In the Cloudflare dashboard, open **Zero Trust** and pick a team name and the Free plan (Cloudflare may ask for a payment method even on the free plan). Your team domain is `<team-name>.cloudflareaccess.com`; you can find it later under **Zero Trust → Settings → Custom Pages**.

2. **Create the Access application.** Zero Trust → **Access → Applications → Add an application → Self-hosted**.
   - Application domain: the hostname you want, e.g. `baby.yourdomain.com`.
   - Session duration: something long like 1 month, so phones don't keep asking you to sign in.
   - Add a policy: Action **Allow**, Include → **Emails** → every email that should have access.
   - Login methods: **One-time PIN** (a code sent by email) works with no extra setup. You can add Google login under Zero Trust → Settings → Authentication if you prefer.
   - Save, then copy the **Application Audience (AUD) Tag** from the app's overview.

3. **Fill in `wrangler.jsonc`.** Everything marked `CHANGE ME`:
   - `routes[0].pattern`: your hostname from step 2
   - `ALLOWED_EMAILS`: the same emails as the Access policy, comma-separated
   - `NAMES` (optional): display names, like `alice@example.com:Alice,bob@example.com:Bob`
   - `ACCESS_TEAM_DOMAIN`: `<team-name>.cloudflareaccess.com`
   - `ACCESS_AUD`: the AUD tag from step 2

4. **Deploy.**
   ```sh
   npx wrangler login
   npx wrangler deploy
   ```
   Wrangler creates the DNS record for the hostname. Give it a minute, then open `https://baby.yourdomain.com`, sign in, and use the browser's **Add to Home Screen** on each phone.

To change who has access later, update both the Access policy and `ALLOWED_EMAILS`, then deploy again.

## How it's locked down

- Cloudflare Access stops anyone not on the list before they reach the app.
- As a second lock, the Worker verifies the Access sign-in token on every request (signature, audience, issuer, expiry, and that the email is in `ALLOWED_EMAILS`) and returns a plain 404 otherwise. With the placeholder values in this repo, it returns 404 for everything.
- `workers.dev` and preview URLs are turned off, since those would skip Access.
- There is nothing secret in `wrangler.jsonc`: the team domain and AUD tag only identify your Access app, and the token checks are what keep people out.

## Notes

- Times show in each phone's local time zone.
- Data lives only in your Cloudflare account. Use **Export CSV** (bottom of the Feeds tab) if you want a copy.
- To rename the app, change the title in `public/index.html` and the names in `public/app.webmanifest`. The icon is `public/icon.png` (512×512).
- If the Diapers tab stops being useful after the early weeks, just ignore it.
- Code layout: `src/index.js` is the Worker (auth check plus a small sync API); `public/` is the whole front end (plain HTML, CSS, and JavaScript).
