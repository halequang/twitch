# POE Skins — Astro + Cloudflare Worker

Landing page built with [Astro](https://astro.build) and deployed as a Cloudflare Worker.
Skin pages are bundled as static assets.

## Routes

| Path         | Source                                | Description       |
| ------------ | ------------------------------------- | ----------------- |
| `/`          | `src/pages/index.astro`               | Landing page      |
| `/thuegame/theisle` | `src/pages/thuegame/theisle.astro` | Member area — Google/Apple login, The Isle rentals, mini-game (old `/game` 301s here) |
| `/admin`     | `src/pages/admin.astro`               | Shop admin — account pool + orders (ADMIN_EMAILS only) |
| `/skins`     | `public/skins.html`                   | Full pack         |
| `/skins2`    | `public/skins2.html`                  | Medium pack       |
| `/skinsOLD`  | `public/skinsOLD.html`                | Legacy pack       |
| `/POE2`      | `public/POE2.html`                    | POE 2 pack        |

Image / CSS / JS for the skin pages are hot-linked from `saydis.pro`.

## Editing content

Most edits happen in two places:

- **Landing page guides** — `src/content/guides/*.md` (markdown with frontmatter).
  Add a new file with `title`, `icon`, `subtitle`, and `order` fields to add a new
  collapsible section. Lower `order` appears first.
- **Styles** — `src/styles/global.css`. All design tokens are CSS variables at the top.

Other key files:

- `src/pages/index.astro` — landing page composition (collection cards + guides loop)
- `src/components/*.astro` — `Header`, `Footer`, `SectionTitle`, `CollectionCard`, `Guide`
- `src/layouts/Layout.astro` — outer HTML shell

## Develop

```bash
npm install            # one-time
npm run dev            # Astro dev server with hot reload — http://localhost:4321
npm run build          # Build to ./dist
npm run wrangler:dev   # Run Cloudflare Worker against built ./dist (port 8788)
```

## Deploy

```bash
npm run deploy         # astro build && wrangler deploy
```

After deploy, the Worker is live at the routes configured in `wrangler.toml`
(`fungamingvn.shop/*` and `www.fungamingvn.shop/*`).

## Structure

```
.
├── public/                 # Static files copied verbatim to dist/
│   ├── FuNGAMING logo.png
│   └── skins*.html, POE2.html
├── src/
│   ├── components/         # Reusable Astro components
│   ├── content/guides/     # Markdown for collapsible Notion sections
│   ├── layouts/Layout.astro
│   ├── lib/                # Shared Worker + dev-server logic (advisor, auth)
│   ├── pages/index.astro   # Landing page
│   ├── pages/thuegame/     # Per-game rental pages (theisle.astro)
│   └── styles/global.css
├── worker/index.js         # Cloudflare Worker entrypoint (routing + /api/*)
├── notion-content/         # Notion mirror archive (read-only reference)
├── astro.config.mjs
├── wrangler.toml
└── package.json
```

## AI buy advisor (Gemini)

A floating "Tư vấn" chat widget (`src/components/AdvisorWidget.astro`, mounted in
`Layout.astro`) lets customers ask which product to buy. It posts the conversation
to `POST /api/advisor` in the Worker, which calls the Google Gemini API with a
catalog-aware Vietnamese system prompt and returns the reply.

**Setup — store the API key as a Worker secret (never commit it):**

```bash
# Get a key at https://aistudio.google.com/apikey
wrangler secret put GEMINI_API_KEY
# paste the key when prompted
```

Optional: override the model (defaults to `gemini-2.5-flash`) by adding a var to
`wrangler.toml`:

```toml
[vars]
GEMINI_MODEL = "gemini-2.5-flash"
```

**Local dev:** put the key in a gitignored `.dev.vars` file at the repo root:

```
GEMINI_API_KEY=your-key-here
```

Then either dev server works — both serve `POST /api/advisor`:

- `npm run dev` — Astro dev server (hot reload). A dev-only Vite middleware in
  `astro.config.mjs` reads `.dev.vars` and calls the advisor.
- `npm run build && npm run wrangler:dev` — runs the real Worker against `./dist`.

Without a key, `/api/advisor` returns 503 and the widget shows a "tạm bảo trì"
fallback pointing to the Telegram bot.

The advice logic and product catalog live in **`src/lib/advisor.js`** (single
source of truth, imported by both the Worker and the dev middleware) — keep the
`CATALOG` there in sync with `src/components/PricingBanner.astro`.

## Login (`/thuegame/theisle`) — Google and Apple

`/thuegame/theisle` (`src/pages/thuegame/theisle.astro`) is a member area: signed out it shows
**Sign in with Google** and **Sign in with Apple** buttons, signed in it shows
the account and a mini game.

Both providers use the same flow: the browser gets an OIDC **ID token** from the
provider's button and POSTs it to `/api/auth/<provider>`; the Worker verifies the
JWT signature against that provider's public keys (checking `iss`, `aud`, `exp`
and `email_verified`) and issues an HttpOnly, HMAC-signed session cookie
(`fg_session`, 7 days). There is no database — the cookie is the session, and
**neither provider's client *secret* is needed**, because we only ever verify an
ID token and never exchange an authorization code.

Endpoints: `/api/auth/config`, `/api/auth/google`, `/api/auth/apple`,
`/api/auth/me`, `/api/auth/logout`. Logic lives in **`src/lib/auth.js`**, shared
by the Worker and the dev middleware, same split as the advisor.

A provider with no client ID configured is simply not offered — the page shows
whichever buttons are available, so you can ship Google first and add Apple later.

### Shared setup

Set the cookie-signing secret once (any long random string; rotating it signs
everyone out):

```bash
wrangler secret put SESSION_SECRET
```

### Google

1. Create an **OAuth 2.0 Client ID** (type: *Web application*) at
   <https://console.cloud.google.com/apis/credentials>.
   Authorized JavaScript origins:
   `https://fungamingvn.shop`, `https://www.fungamingvn.shop`,
   `http://localhost:4321`, `http://localhost:8799`.
   (No redirect URI needed — the Google Identity Services button is used, not a
   redirect flow.)
2. Put the client ID in `wrangler.toml` under `[vars]` as `GOOGLE_CLIENT_ID`.
   It is public — it ships in the page.

### Apple

Apple needs a paid Apple Developer account, and the setup is a chain of four
identifiers — the one we want is the **Services ID**, not the App ID:

1. <https://developer.apple.com/account/resources/identifiers> → create an
   **App ID** with *Sign in with Apple* enabled.
2. Create a **Services ID** (e.g. `shop.fungamingvn.web`), enable *Sign in with
   Apple* on it, and configure it against the App ID above. This Services ID
   string is `APPLE_CLIENT_ID`.
3. In that same panel register:
   - **Domains**: `fungamingvn.shop`
   - **Return URLs**: `https://fungamingvn.shop/thuegame/theisle` (must match
     `APPLE_REDIRECT_URI` exactly)
4. Put both in `wrangler.toml` under `[vars]`:

   ```toml
   APPLE_CLIENT_ID = "shop.fungamingvn.web"
   APPLE_REDIRECT_URI = "https://fungamingvn.shop/thuegame/theisle"
   ```

Apple quirks worth knowing:

- **No localhost.** Apple rejects `localhost` as a domain or return URL, so Apple
  login can only be exercised on the real https domain (or an https tunnel).
  Leave `APPLE_CLIENT_ID` blank in `.dev.vars` and only the Google button shows.
- **The name arrives once.** Apple sends the user's display name alongside the
  token on the *first* authorization only, and never again. It is client-supplied,
  so it is sanitised and used for display only — identity always comes from the
  verified `sub`. Returning users fall back to their email as the display name.
- **No avatar.** Apple provides no profile picture, so the avatar is hidden.
- **Private relay.** Users may hide their address; the email is then an
  `@privaterelay.appleid.com` relay.
- **`email_verified` is a string** (`"true"`), not a boolean, unlike Google.
- The popup only closes cleanly if the return URL's hostname is registered on the
  Services ID.

### Local dev

Mirror the same names in `.dev.vars`:

```
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
APPLE_CLIENT_ID=
SESSION_SECRET=some-long-random-string
```

Note `.dev.vars` **overrides** `wrangler.toml` `[vars]` for `wrangler dev`, so an
empty entry there disables that provider locally even when production has it set.

## Steam account rentals (The Isle) via payOS

The `/thuegame/theisle` member area sells timed rentals of shop-owned Steam accounts. A
signed-in user picks a plan, pays through payOS (bank transfer / QR), and the
account's login and password appear on the page with a countdown. When the
rental expires the account returns to the pool automatically.

Pieces:

| File | Role |
| ---- | ---- |
| `src/data/rental-plans.js` | Catalogue — durations and VND prices. Edit freely; keep plan `id`s stable once real orders exist. |
| `src/lib/payos.js` | payOS client. Signature rules mirror `@payos/node` exactly. |
| `src/lib/rentals.js` | Inventory, orders, allocation, credential encryption. |
| `migrations/0001_rentals.sql` | D1 schema (`steam_accounts`, `orders`). |
| `scripts/add-rental-account.mjs` | Adds an account to the pool (handles encryption). |

Endpoints (Worker only — they need D1): `GET /api/rent/plans`,
`POST /api/rent/checkout`, `GET /api/rent/orders`, `POST /api/payos/webhook`.

### How an order flows

1. `POST /api/rent/checkout` checks stock, writes a `pending` order, and asks
   payOS for a payment link. The user is redirected to it.
2. payOS calls `POST /api/payos/webhook`. **The signature is verified before
   anything else** — an unverified body is dropped, since a forged webhook would
   otherwise hand out Steam credentials for free.
3. The order claims one available account atomically (`UPDATE ... RETURNING`, so
   two simultaneous payments can never get the same login), goes `active`, and
   gets `expires_at = now + plan hours`.
4. On the return URL the page reloads its orders. If the webhook never arrived,
   `/api/rent/orders` asks payOS directly and fulfils the order there — a missed
   webhook does not strand a paying customer.
5. Any request that touches stock first sweeps lapsed rentals back to
   `available`. No cron job needed.

Credentials are released **only** for an `active` order whose `user_key` matches
the session, and are encrypted at rest with AES-GCM under `ACCOUNT_ENC_KEY`.

### Setup

1. Create the database and apply the schema:

   ```bash
   npx wrangler d1 create fungaming-rentals
   # paste the returned database_id into wrangler.toml → [[d1_databases]]
   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0001_rentals.sql
   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0001_rentals.sql
   ```

2. Set the secrets (payOS dashboard → Kênh thanh toán → API):

   ```bash
   npx wrangler secret put PAYOS_CLIENT_ID
   npx wrangler secret put PAYOS_API_KEY
   npx wrangler secret put PAYOS_CHECKSUM_KEY
   npx wrangler secret put ACCOUNT_ENC_KEY   # any long random string
   ```

   Mirror the same four in `.dev.vars` for local work.

   > `ACCOUNT_ENC_KEY` cannot be rotated casually — changing it makes every
   > already-stored password undecryptable. Re-add the accounts if you rotate it.

3. Register the webhook in the payOS dashboard:
   `https://fungamingvn.shop/api/payos/webhook`
   (payOS probes the URL when you save it; the endpoint answers 200 to the probe.)

4. Stock the pool — one account at a time:

   ```bash
   node scripts/add-rental-account.mjs --login isle_01 --password 'the-password' \
     --note 'Vui lòng bật Offline Mode' --remote
   ```

   …or in bulk from a text file:

   ```bash
   node scripts/add-rental-account.mjs --file scripts/steam_accounts.txt --dry-run
   node scripts/add-rental-account.mjs --file scripts/steam_accounts.txt --remote
   ```

   Line format — fields separated by `----`, with an optional private note after
   `->`. The mail password is optional:

   ```
   login----password----email                      -> internal note
   login----password----email----emailPassword     -> internal note
   ```

   Re-running an import is safe: existing logins are left untouched
   (`INSERT OR IGNORE` on the unique `(game, login)`). `--dry-run` parses and
   reports without writing; `--sql-only` prints the statements instead.

   > **Never commit the source file.** `scripts/*accounts*.txt` is gitignored
   > because it holds plaintext Steam credentials.

   Omit `--remote` to seed the local database.

### What the renter actually sees

| Column | Shown to renter? |
| ------ | ---------------- |
| `login`, `password` | Yes — that is the rental. |
| `note` | Yes — set it with `--note`. |
| `email`, `email_password_enc` | **No**, unless `RENTAL_RELEASE_EMAIL` is on. |
| `internal_note` (the `->` text) | Never. Shop bookkeeping only. |

Steam Guard emails a code on first login from a new device, so a renter with only
the login and password may be unable to sign in. Options, worst to best:

- Set `RENTAL_RELEASE_EMAIL = "1"` in `wrangler.toml` `[vars]` to hand the mailbox
  over with the credentials. **This gives the rental away permanently** — whoever
  holds the mailbox can reset the Steam password and keep the account. Off by
  default.
- Better: disable Steam Guard on the pool accounts, or relay codes to customers
  manually.

### Local development

Rentals need the D1 binding, so they only run under the Worker:

```bash
npm run build && npx wrangler dev --local --port 8799
```

Under plain `npm run dev` the rental endpoints answer 503 with a hint — the rest
of the page (login, mini-game) still works.

### Operational notes

- **Out of stock at payment time.** If the pool empties between checkout and the
  webhook, the order is parked as `awaiting_stock` and shown to the customer with
  its order code, rather than silently swallowed. Add an account or refund.
- **Steam's Subscriber Agreement prohibits account sharing**, so rented accounts
  can be banned. That is a business risk to weigh, not a code issue.
- Prices are VND integers; payOS settles VND only.

## Admin panel (`/admin`)

Manage the Steam account pool and inspect every order. It reuses the normal
Google/Apple session — an admin is just a signed-in user listed in
`ADMIN_EMAILS` (`wrangler.toml` `[vars]`):

```toml
ADMIN_EMAILS = "you@shop.vn, apple:0012.abc"
```

Entries are an email, or `provider:sub` for accounts with no usable email (Apple
private relay). **It fails closed** — leave it empty and the panel is shut to
everyone, so a misconfigured deploy locks you out rather than opening the account
pool to every logged-in customer.

What it does:

- **Accounts** — add, edit (rename, email, notes, status, rotate password),
  delete, and reveal a stored password on demand.
- **Orders** — every order with customer, plan, amount, status, which login it
  holds, and timestamps.
- **Summary** — pool counts, active rentals, orders awaiting stock, paid revenue.

Safety rules built into the API (`src/lib/admin.js`), not just the UI:

- Listings **never** include passwords, encrypted or not. Revealing one is a
  separate explicit call (`POST /api/admin/accounts/:id/reveal`).
- An account held by an **active rental** cannot be flipped to `available`, and
  deleting it requires an explicit `?force=1` — otherwise you would silently
  strip the login from a paying customer.
- Deleting an account detaches it from past orders rather than cascading, so
  order history survives.
- On edit, a blank password field means "leave unchanged" — for **both** the Steam
  and the mail password. A form that always submits every field therefore cannot
  silently wipe a stored password. Clearing one deliberately is an explicit
  `null`. Blanking a plain text field (email, notes) does clear it.

### Renaming a rental page

The page path lives in **one** place — `path` on the game in
`src/data/rental-plans.js`. The Worker route, the payOS return/cancel URLs and the
Apple redirect URI all read from it, so they cannot drift apart.

If you rename one, also:

1. add the old path to `MOVED` in `worker/index.js` (a 301 that preserves the
   query string) — payOS links created before the rename carry the old
   `returnUrl`, and a paying customer must not hit a 404;
2. update `APPLE_REDIRECT_URI` in `wrangler.toml`;
3. update the **Return URL** on the Apple Services ID, which must match exactly.

## Expiry alerts (Telegram)

When a rental ends the previous renter **still knows that Steam password**, so the
account must not go back out until it is rotated. The Worker tells the shop owner
so that does not get missed.

Detection runs on a **Cron Trigger** (`wrangler.toml` → `[triggers] crons`, every
15 min) rather than piggybacking on traffic: expiry is otherwise only noticed when
a customer happens to load the rental page, so a rental ending at 3am would go unnoticed.
The scheduled handler sweeps lapsed rentals back into the pool, then announces
whatever ended.

```bash
# @BotFather → /newbot, then send your bot a message and read the chat id from
# https://api.telegram.org/bot<TOKEN>/getUpdates
wrangler secret put TELEGRAM_BOT_TOKEN
```

```toml
# wrangler.toml [vars]
TELEGRAM_CHAT_ID = "123456789"
```

The message names the order, the customer, **which Steam login is affected**, and
the rotation command. Logic lives in `src/lib/notify.js`.

Behaviour worth knowing:

- **Announced exactly once.** `orders.notified_at` is the marker, so a cron every
  15 minutes does not re-announce the same expiry.
- **A failed send is retried, never lost.** Rows are marked only *after* Telegram
  accepts the message; a failure leaves them outstanding for the next run.
- **Unconfigured is not the same as done.** With the token/chat id unset nothing
  is sent and nothing is marked, so switching them on later still announces
  whatever is outstanding.
- Pre-existing expiries are backfilled as already-announced by migration `0004`,
  so enabling this does not flood you with ancient history.
- `GET /api/admin/expired` lists the same queue, so the panel shows what needs
  rotating even with no bot configured.

## Uploading images to the CDN (R2)

Images served from `cdn.fungamingvn.shop` live in the R2 bucket `poe-skins-assets`.
To publish new ones, drop files into `pending-images/` (folder structure is
preserved — `pending-images/guides/poe/x.png` → `cdn.fungamingvn.shop/guides/poe/x.png`)
and run the upload script:

```bash
set -a; . ./.env; set +a; sh scripts/upload-images.sh
```

It uploads every file, prints a markdown `![...](...)` snippet per file, and moves
uploaded files to `pending-images/.uploaded/`.

**Credentials — the bucket lives under a specific Cloudflare account, so the script
needs an R2-scoped API token (not the interactive `wrangler login`).** Store them in
a gitignored `.env` at the repo root:

```
CLOUDFLARE_ACCOUNT_ID=9a0bdae942498efd47e7c1337b0d964f
CLOUDFLARE_API_TOKEN=your-r2-token-here
```

Create the token at Cloudflare dashboard → My Profile → API Tokens → Create Token,
with **R2 Storage: Edit** permission on the account above. The `set -a; . ./.env`
prefix exports these into the environment so wrangler authenticates with the token
(which overrides any `wrangler login` session). A `403 / Authentication error` means
either the token lacks R2 scope or belongs to the wrong account.

## Customising the worker

The worker (`worker/index.js`) maps clean URLs (`/skins` → `/skins.html`) to files in
the built `dist/` directory. To change the Worker name in Cloudflare, edit the
`name` field in `wrangler.toml` before running `npm run deploy`.
