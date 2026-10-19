# Customer Connect

Email blasts and scheduled campaigns for your stores' customer lists. It is the promo email part of Chat Support Pro (Campaigns, Create Campaign, Recipients, Templates), split into its own app.

- **Campaigns**: send now, or schedule batches (e.g. 100 every hour) with an optional daily limit, daily sending hours, end time and timezone. Pause, resume, edit or stop while it runs. Sending happens on the server, so nobody needs to keep a tab open.
- **Audience**: everyone, a store segment ("PC", "ARL"), or specific stores; filter by country; optionally include chat-only customers, and leave out people a store already emailed.
- **Customers**: one customer per email, linked to the store of their latest order or chat. They come in automatically from the checkout portal (every paid order) and Chat Support Pro (every 15 minutes), or from a CSV upload or adding by hand. Everything is cleaned before it's saved (see below).
- **Templates**: paste your own HTML with `{{tokens}}`, preview with sample data, send a test as any store, download the HTML.
- **Stores**: each store is a sender with its own name, address, reply-to and brand colour, grouped like in Chat Support Pro.
- **Opt-outs**: one-click unsubscribe (works with Gmail/Yahoo's unsubscribe button), a blocklist, Resend's bounce/complaint list, and, when linked, Chat Support Pro's unsubscribes and blacklist. Checked again before every batch.

## Run it

Needs Node 18.17+ and Postgres 15+ (its own database; Chat Support Pro already needs 15+). No Redis.

```bash
npm install
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm start                     # http://localhost:3000
```

The zip already contains the built web app in `dist/`, so `npm start` serves it straight away. Without `RESEND_API_KEY` the app runs in **dry run**: emails are built exactly as they would be sent, but kept under **Settings → Outbox** instead. Use this to try everything safely.

Development, with hot reload: `npm run dev` (web on :5173, API on :3000). After changing anything in `src/`, run `npm run build` again.

Other commands:

| | |
|---|---|
| `npm run create-admin -- you@example.com 'password' "Your Name"` | create an admin, or reset a password |
| `npm test` | unit tests |
| `TEST_DATABASE_URL=… TEST_CSP_DATABASE_URL=… npm test` | also the saving-rules and end-to-end tests against Postgres (**wipes** both databases; their names must contain "test") |

## Go live

1. **Resend**: verify each sending domain (Domains → Add), create an API key, and set `RESEND_API_KEY`. A store's sender address must be on a verified domain; stores without one use `DEFAULT_FROM_EMAIL`.
2. **APP_URL**: the public https address. Unsubscribe links in every email point to `APP_URL/u`, so it must stay reachable.
3. **Deploy** (Render, Railway, Fly…): one web service.
   - Build: `npm ci --include=dev && npm run build`
   - Start: `npm start`
   - Health check: `/healthz`
   - Environment: everything in `.env.example`.
4. Sign in, then **Stores**: add your stores, or link Chat Support Pro (below) and press **Settings → Sync now**.

Several instances can run at once: the sender locks each campaign while it sends a batch, so no email goes out twice. To keep one instance web-only, set `DISABLE_WORKER=true` on it.

## Customers

**One customer per email.** Each customer is linked to one store: the store of their **latest order or chat**, by when it happened (not when Customer Connect received it), so re-sending old data never moves anyone back. Every store they were ever linked to stays in their history (Customers → "2 stores").

| Situation | Result |
|---|---|
| Ordered at Montreal on Oct 1, then Ottawa on Oct 2 | Ottawa. Montreal stays in history. |
| The Oct 1 Montreal order arrives again later | Still Ottawa |
| A row with no date (e.g. a CSV without `last_order_date`) | Adds a new customer, fills in a missing name or phone, but never moves an existing customer |
| Same moment at two stores | Checkout beats added-by-hand beats chat beats upload |
| A newer row with no name, or "Guest" | The saved name stays |
| A name typed on the Customers page | Never replaced by a sync or import |

Group, country and brand colour come from the customer's store (set on the Stores page).

**Cleaning.** Every row, from any source, is cleaned before it's saved:

- spaces and capitals removed; misspelled providers fixed (`gmail.con`, `gmial.com`, `gmail.ca`, `hotmial.com`, `yahooo.com`…), while real look-alikes such as `mail.com`, `ymail.com`, `gmx.com` and `yahoo.ca` are left alone;
- not saved: emails with "test" as a word (`test@`, `test123@`, `john.test@`; but `latest.deals@` or `anna.testa@` are fine), placeholder and throwaway addresses (`example`, `noreply`, mailinator…), anything that isn't an email address, and **domains that receive no mail** (random text). Company and Proton addresses are fine;
- not saved: store addresses on `myshopify.com` or `pepscheckoutportal.com`;
- old store domains move to their main store (the list in `server/lib/customerRules.js`, from Chat Support Pro);
- phones are written as `+16135550101`; a number that can't be read is left blank.

The "receives mail" check asks DNS for the domain's mail servers, once per domain (cached). If DNS doesn't answer, the customer is saved as **unverified**, left out of campaigns, and checked again every hour. If DNS on the server is broken altogether, nobody is thrown away. Set `EMAIL_DOMAIN_CHECK=off` only if the server can't do DNS lookups.

Each import, sync and portal batch reports what was fixed and what wasn't saved, and why.

**CSV upload** (Customers → Import file; the template is downloadable there):

```csv
customer_name,email,store_name,store_url,phone,last_order_date
Jane Doe,jane.doe@gmail.com,Ottawa Peptides,https://ottawapeptides.com,613-555-0101,2026-10-02
```

`email` and `store_url` are required. Common header spellings ("Email Address", "Store URL", "Phone Number") also work. Checking a file saves nothing. Stores the file names that aren't set up are listed with an **Add these stores** button; their rows import once the stores exist. Rows not saved can be downloaded as a CSV.

Customers that arrive from the portal or Chat Support Pro for a store that isn't set up are kept, and listed on the Stores page ("waiting for a store") until it's added.

## Link the checkout portal

Each paid order (`paid` or `manual`) sends its customer to Customer Connect within a minute: email, name, phone, the storefront it came from and when it was paid. The portal's database is never opened to the internet.

1. Make up a long random secret: `openssl rand -hex 32`.
2. Customer Connect: set `CHECKOUT_PORTAL_SECRET` to it and restart.
3. Checkout portal: apply the update in [`checkout-portal-update/`](checkout-portal-update/README.md) (its README says how), set `CUSTOMER_CONNECT_URL` to this app's address and `CUSTOMER_CONNECT_SECRET` to the same secret, then restart the web app **and** the Celery worker.
4. Once, for orders from before: `python scripts/customer_connect_backfill.py --all` on the portal server.

Requests are signed and expire after 5 minutes. Sending an order twice is harmless. Settings → Checkout portal shows when the last order arrived and how many weren't saved.

## Link Chat Support Pro (optional)

Set `CHAT_SUPPORT_DATABASE_URL` to Chat Support Pro's database. The connection is forced read-only; Customer Connect never changes Chat Support Pro. A dedicated read-only Postgres user is still best:

```sql
CREATE ROLE cc_reader LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE <csp_db> TO cc_reader;
GRANT USAGE ON SCHEMA public TO cc_reader;
GRANT SELECT ON stores, conversations, customers, blacklist, promo_unsubscribes, promo_sent_emails TO cc_reader;
```

Then:

- Every `CHAT_SUPPORT_SYNC_MINUTES` (15 by default) it copies what changed: stores (name, domain, group, country, brand colour, sender), customers who chatted (dated by their **last chat**, so latest-store-wins works across chats and orders), customers from Chat Support Pro's uploads and manual adds (undated), unsubscribes, the active blacklist and the promo sent history. **Settings → Sync now** runs it straight away; **Full re-sync** reads everything again. Store access tokens are never read.
- A blacklisting there blocks the person here for every store, including after they move to another store.
- Before every batch, the recipients are also checked against Chat Support Pro's unsubscribes and blacklist. If that database can't be reached, the batch waits 5 minutes and tries again instead of risking an email to someone who opted out.
- Stores that came from Chat Support Pro are overwritten by the next sync, so edit their details there.

Unsubscribe links in emails sent earlier by Chat Support Pro still go to Chat Support Pro; the sync and the live check carry those opt-outs over.

## Templates

Same tokens as Chat Support Pro, so existing templates work unchanged:

`{{customer_name}}` `{{customer_email}}` `{{store_name}}` `{{store_url}}` `{{store_domain}}` `{{store_brand_color}}` `{{store_brand_color_light}}` `{{store_brand_text_color}}` `{{store_brand_rgb}}` `{{unsubscribe_url}}` `{{moved_banner}}` `{{moved_banner_text}}`, plus lookup blocks:

```html
<!--@map product_image_url from store_brand_color
Red  #D23025 = https://cdn.example.com/red.png
default      = https://cdn.example.com/blue.png
-->
<img src="{{product_image_url}}">
```

Every link to the recipient's own store gets `utm_source` (store domain), `utm_medium=promo_email`, `utm_campaign` (campaign name) and `utm_content` (the link's text or image alt).

## How it fits together

```
server/
  index.js                Express app, starts the sender
  config.js  db.js        settings; schema (created/updated on start)
  auth.js                 sign-in (bcrypt + JWT), roles admin / editor
  lib/merge.js            tokens, brand colours, @map blocks, UTM tags
  lib/schedule.js         timezone, sending hours, next-send rules
  lib/customerRules.js    old-domain moves, typo and test-email lists (from Chat Support Pro)
  lib/clean.js            cleans one customer row (email, store, name, phone, date)
  services/ingest.js      the one way customers are saved: one per email, latest store wins
  services/mailDomains.js does an email domain receive mail? (DNS, cached)
  services/jobs.js        Chat Support Pro sync, unverified re-checks
  services/campaigns.js   create/edit/pause campaigns; sends a batch
  services/worker.js      checks for due campaigns every 10 s
  services/sender.js      builds one email, sends via Resend (retries, idempotency)
  services/optOuts.js     unsubscribes, blocklist, Resend suppressions, CSP
  services/chatSupportBridge.js   read-only sync and checks against CSP
  routes/ingest.js        signed endpoint the checkout portal sends paid orders to
  routes/                 the JSON API
src/                      the React web app (Vite)
test/                     unit + end-to-end tests
```

A campaign's schedule lives in its database row (`next_fire_at`), not in a queue, so restarts lose nothing. An email interrupted mid-send by a restart is marked failed, not sent again.

### What changed from Chat Support Pro's promo pages

- No Redis/BullMQ; the schedule is kept in Postgres.
- "Send now" runs on the server too (CSP sent it from the browser, one request per recipient).
- The unsubscribe link handles the one-click POST from mail apps; opening the link shows a confirm button, so link scanners can't unsubscribe people.
- Resend rate limits (429) are retried with backoff instead of counting as failed sends.
- Pause and Stop take effect within the batch that's sending, not after it.
- The "we've moved" banner uses plain colours (CSS variables don't work in email).
- One customer per email (CSP emailed the same person once per store), linked to their latest store; a campaign goes out as the store the customer belongs to at send time.
- A block applies to every store.
- New: campaign details with failures and skip reasons; customer CSV export; Do-not-email list; user management.
