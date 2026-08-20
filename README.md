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
npm run deploy          # astro build && npm run migrate && wrangler deploy
npm run migrate         # apply outstanding migrations to production
npm run migrate:local   # ...to the local dev DB
npm run migrate:list    # what is outstanding, without applying it
```

Migrations run **before** the Worker goes out, so new code never meets an old
schema, and the steps are chained with `&&` — a failed migration aborts the deploy
rather than shipping against a database that could not be updated.

Migrations are tracked by wrangler in a `d1_migrations` table, so re-running is a
no-op. They were originally applied by hand with `d1 execute --file`, which left
that ledger empty; it has since been backfilled with `0001`–`0011` after verifying
each one's columns and tables were genuinely present in production. If you ever add
a migration by hand again, insert its filename into `d1_migrations` too, or the next
deploy will try to re-run it and fail on a duplicate column.

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

## Sign up with an email address

Alongside Google and Apple, someone can create an account with an email and a
password. Three steps, because the address has to be proven before it can own a
password:

```
POST /api/auth/register  {email}            → mails a 6-digit code
POST /api/auth/verify    {email, code}      → returns a short-lived claim token
POST /api/auth/complete  {token, password}  → creates the user, sets the session
POST /api/auth/login     {email, password}  → sets the session
```

Needs `RESEND_API_KEY` + `RESEND_FROM` (see the reminder section below) and D1.
The endpoints answer `503 email_signup_unavailable` without a database, so the
Astro dev server — which has no D1 binding — offers Google/Apple only; use
`wrangler dev` to exercise this flow locally.

Behaviour worth knowing:

- **The claim token is why there are three steps, not two.** Step 3 must not take
  the browser's word for which address was verified, so step 2 returns an HMAC
  over the address under `SESSION_SECRET`. A client cannot mint one for an address
  it never proved. Tested by re-signing a forged payload with a valid signature.
- **Codes are stored hashed**, with a 10-minute life, a 60-second resend cooldown,
  and 5 attempts. Once the attempts are spent even the *correct* code is refused —
  a new one must be sent, or the ceiling would mean nothing.
- **A failed send drops the code row**, so a Resend outage cannot leave someone
  locked out by a cooldown for a failure that was never theirs.
- **Passwords are PBKDF2-HMAC-SHA256** via WebCrypto: the Workers runtime has no
  bcrypt, scrypt or argon2. The iteration count lives inside each hash, so raising
  `PASSWORD_KDF_ITERATIONS` later does not strand existing rows. The default of
  100k is a compromise with the Workers CPU limit rather than an OWASP-blessed
  number — raise it on a paid plan and verify the login endpoint still fits.
- **Sign-in reveals nothing about which addresses exist**: an unknown address is
  hashed against a dummy so the timing matches, and both answer `bad_credentials`.
  Registration *does* say `already_registered`, deliberately — otherwise a
  returning customer has no way to learn they should sign in instead.
- Addresses are matched case-insensitively but stored as typed, so `Ha@x.com`
  cannot register a second account over `ha@x.com`.
- Email users get the same `provider:sub` session shape as OIDC ones
  (`email:<id>`), so rentals, extensions and the admin scoping all work unchanged.

**Not built yet:** password reset. Someone who forgets theirs currently needs you
to intervene. The pieces are all here (`email_codes` already carries a `purpose`
column) but the flow is not wired.

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

### Holding an account for one customer

An account can be earmarked for a specific customer, so when they rent again they
get that same login back instead of whatever is free. Set **Giữ cho khách (email)**
in the account editor in `/admin`; clear the field to release it.

- **Matched on the customer's email**, case-insensitively, because that is what you
  know and what orders already record. Consequence: Apple sign-in permits a null
  email, so a customer who signed in that way cannot be reserved for.
- **Nobody else is ever given a held account**, even while its status is
  `available` — a reservation that the next stranger could take would be no
  reservation at all.
- **Stock is therefore counted per viewer**: the unreserved accounts plus any held
  for you. Counting every `available` row would promise stock that checkout then
  refuses as `out_of_stock`, which is worse than the smaller honest number. Signed
  out, the page shows the unreserved count.
- **The hold outlives the rental.** When it lapses the account returns to
  `available` as normal, still earmarked — that is the whole point.
- Preference and exclusion are one `ORDER BY` inside the single
  `UPDATE … RETURNING` that allocates an account. Splitting it into two queries
  would reopen the race that statement exists to close.

`migrations/0010_account_reserved_for.sql`.

### Buying the account outright

A customer holding a rental can buy that exact login for **190,000đ**, offered
beside the extend buttons. It is the answer to the warning above the plan cards:
rented accounts cannot sign in to a server's own website for voice chat, because
that needs the mailbox — and a purchase hands the mailbox over, so buying is what
actually fixes it.

Defined as `GAMES['the-isle'].purchase` in `src/data/rental-plans.js`, deliberately
outside `plans` so it does not become a third pricing card: it is only reachable
from a rental you already hold.

What a completed purchase does:

- `steam_accounts.status` → **`sold`**, unconditionally. Every allocation query
  filters on `available`, and `steam_change_password.py` refuses to revive a sold
  row, so the login can never be handed to anyone else.
- the rental it replaces → order status `sold`, `expires_at` cleared, so it stops
  counting down.
- the purchase order → `active` with **`expires_at = NULL`**. That NULL is what
  makes it permanent: the sweep, the expiry reminder and the "expiring soon" panel
  all test `expires_at IS NOT NULL`, so each ignores it rather than trusting a
  year-2099 sentinel nobody would notice was wrong.
- credentials keep being released for as long as they own it, **including the
  mailbox** — regardless of `RENTAL_RELEASE_EMAIL`, which only governs renters.

Guards worth knowing:

- Buying needs a rental: `purchase_needs_rental` without one, and the parent order
  is looked up scoped to `user_key`, so nobody can buy someone else's rental.
- One unpaid checkout at a time per user and target, **but a purchase gets its own
  slot**. An extension and a buy-out of the same rental both point at that order,
  so sharing one would hand back the 50k extension link for a 190k purchase.
  Keying on `plan_id` outright would have given every plan its own slot and lost
  the original guard — there is a test for both halves.
- The buy button asks for a second click before creating the order. It is
  irreversible and roughly four times the weekly price, so it should not be one
  stray tap away from "1 tuần · 50k".
- Fulfilment is idempotent, like the rest: payOS delivers webhooks twice.

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
- **Sắp hết hạn** — rentals ending within a selectable window (6h / 24h / 3d /
  7d), soonest first, with under-an-hour flagged red. Lets you rotate passwords or
  chase a renewal before the account frees itself. `GET /api/admin/expiring?hours=N`.
- **Orders** — every order with customer, plan, amount, status, which login it
  holds, and timestamps.
- **Summary** — pool counts, active rentals, orders awaiting stock, paid revenue.

### Groups and scoped managers

Steam accounts can be filed into **groups** ("Kho A", a supplier, a batch), and a
**manager** is assigned one or more groups. A manager sees and edits only accounts
in their groups, plus the orders that used those accounts — including revenue,
which is theirs alone, not shop-wide.

| | Owner | Manager |
| --- | --- | --- |
| Source | `ADMIN_EMAILS` var | `managers` table |
| Accounts | all, including ungrouped | their groups only |
| Reveal password | any | their groups only |
| Orders / revenue | shop-wide | their accounts only |
| Create groups, add managers | yes | no |

The **owner stays in `ADMIN_EMAILS`, not the database**, on purpose: if the owner
were a row, deleting it would lock everyone out of the panel with no way back in.
The env var is the recovery path.

Two deliberate choices in the scoping:

- A manager with **no groups assigned matches nothing**, never everything — an
  unscoped query must not silently become shop-wide.
- Accounts with `group_id NULL` are **owner-only**, so pre-existing stock does not
  become readable the moment the first manager is added.
- Rows outside a manager's groups answer **404, not 403** — a 403 would confirm
  the account exists and leak another group's inventory.

Account statuses: **available** (in the pool), **rented** (out with a customer),
**sold** (left the rental business for good), **disabled** (parked). Every
allocation query filters on `available`, so `sold` and `disabled` accounts are
never rented, counted as stock, or reclaimed by an extension — and
`steam_change_password.py` leaves those two states alone rather than returning
them to the pool after a rotation.

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

## Why the member page looks like phishing (and what was done)

`/thuegame/theisle` collects a password and names Steam, Google and Apple on a
`.shop` domain. That is also the exact shape of a credential-harvesting page, and a
heuristic scanner cannot tell the difference from the markup alone.

Two things were changed to make the difference machine-readable and reader-obvious:

- **`public/_headers`** publishes `form-action 'self'`, `frame-ancestors 'self'` and
  `base-uri 'self'`, plus `nosniff`, a referrer policy and HSTS. `form-action` is the
  important one: it proves the page cannot post a password to another origin, which
  is precisely what a phishing kit must do.
- **The password fields now say whose password they want** — "mật khẩu tài khoản
  FunGaming VN", with "không phải mật khẩu Steam". A customer on a page about Steam
  accounts could otherwise reasonably type their *Steam* password into it, which is a
  real risk to them regardless of what any scanner thinks.

Two traps found while doing it:

- Headers set in `worker/index.js` never reach the pages. Cloudflare's asset server
  answers HTML before the Worker runs, so only Worker-generated responses (404s)
  carried them. Hence `_headers`.
- Setting `run_worker_first` to fix that **307-loops**: the Worker's own
  `env.ASSETS.fetch` re-enters the same route. Do not reach for it here.

The CSP deliberately omits `script-src`, `style-src` and `frame-src`. Google
Identity, `appleid.cdn-apple.com`, `api-merchant.payos.vn` and Google Fonts all load
cross-origin, and a wrong value breaks sign-in or checkout — tighten in one
deliberate, browser-verified step.

Code changes cannot clear an existing blocklist entry. Check status and appeal at
Google Safe Browsing (`transparencyreport.google.com/safe-browsing/search`),
Microsoft SmartScreen, and the specific vendor that flagged it.

## Which account a customer gets

`claimAccount` in `src/lib/rentals.js` picks in this order, most specific first:

1. **Reserved for that customer** (`reserved_for` matches their email) — it was set
   aside for them by name.
2. **Stock no manager can claim** — ungrouped, or in a group with no manager
   attached. The shop's own stock earns before a manager's does, so it is spent
   first and theirs is held back until it runs out.
3. **Lowest id**, so the pool cycles predictably.

This delays manager stock, it does not withhold it: once the shop's own accounts
are all out, manager-owned ones are allocated normally.

Note that allocation now reads `manager_groups`, so migration `0005` is required
for renting to work at all — not just for the admin panel.

## Fixing an order by hand

`PATCH /api/admin/orders/<orderCode>` with `{status?, accountId?, hours?, force?}`,
or the **Sửa** button on any row of the orders table.

It exists for three situations nothing else could repair: an order paid while the
pool was empty (`awaiting_stock`, no `account_id`), a customer sitting on an
account that later turned out to be banned, and accounts left `rented` with no
order behind them.

Behaviour worth knowing:

- **Assignment claims the account atomically**, with the same nested-SELECT-inside-
  one-UPDATE that checkout uses, so an admin and a paying customer cannot both take
  the last account. A busy account is refused with `account_unavailable`.
- **The previous account is released** — but only if no *other* live order is on it.
- **A banned account is refused** (`account_banned`) unless you pass `force: true`;
  the panel asks before overriding. This shop has already handed two customers
  Steam-locked logins.
- **Activating requires an account** (`needs_account`), because telling a customer
  their rental is ready and then showing them nothing is worse than leaving it
  pending.
- **The clock starts now, not at payment.** A stuck order gets its full hours from
  the moment it is actually delivered — charging for time the customer could not use
  is not on. `reminder_sent_at` is cleared too, so the expiry email still fires.
- **Ending an order releases its account**, and `pending` is not settable: that
  status belongs to payOS, and forcing it back would orphan a real payment.
- Scoped like everything else. An order holding one of your accounts is yours to
  fix; an unassigned one is only yours if the account you assign is.

## Customer records

A successful Google or Apple sign-in is recorded in `users` — the same table the
email+password accounts use, not a second one. `recordOauthLogin` in
`src/lib/email-auth.js`, called from `handleAuthRequest`.

- **Keyed on email, so one person is one row.** A customer who signs in with Google
  and later sets a password is a single account. Orders are attributed by
  `user_email`, so a split identity would split their rental history.
- **An existing password is never touched.** Signing in with Google leaves a
  password-holder's hash alone, and that password still works afterwards.
- **A provider row stores `password_hash = 'oauth-only'`**, which cannot
  authenticate: `verifyPassword` requires exactly `pbkdf2$sha256$<iter>$<salt>$<hash>`
  and rejects anything else on the format, before comparing. This is asserted in the
  tests, because it is the whole reason the column could stay `NOT NULL` instead of
  rebuilding a live table.
- **A name the customer set is not overwritten** by whatever the provider currently
  returns, and a null picture does not erase a stored one.
- **Apple can withhold the email** (private relay). Those sign-ins are skipped rather
  than crashing — the email is the key here.
- **A failed write never costs someone their login.** The token is already verified
  at that point, so the error is logged and the session is still issued.
- `login_count` and `last_login_at` are maintained, and migration `0011` backfills
  existing rows as `provider = 'email'` with a count of 1 rather than leaving every
  current customer looking like they had never signed in.

## Daily report

`GET /api/admin/report[?date=YYYY-MM-DD]`, shown as the **📊 Báo cáo ngày** card at
the top of `/admin` with a date picker and a "hôm trước" step.

It reports **revenue, not profit** — nothing in the schema records what an account
cost or what a manager's cut is, so a margin cannot be derived. The card says so
too, in Vietnamese, next to the number.

Behaviour worth knowing:

- **The day is the Vietnam day** (`+7 hours`). A UTC boundary would cut the evening
  in half and file sales under the wrong date.
- **Split by where the account came from**: each group by name, the shop's own
  ungrouped stock, and — separately — orders that took money and delivered no
  account at all. Those three are very different things and lumping them hides the
  only one that needs action.
- **Sold-but-unusable is stated beside the total.** Orders on `ban_state='banned'`
  accounts are counted and their revenue named, because they inflate takings while
  being the opposite of a good day. On 19/08 that was 4 orders / 80.000₫, all from
  one group.
- **Scoped.** A manager sees their own groups only, and never the shop-wide total or
  the undelivered bucket — those cannot be attributed to a group.
- An invalid `?date=` falls back to today rather than erroring, and the picker is
  reset to whatever day the server actually reported on, so it cannot drift from the
  numbers beside it.

## Renter problem reports

A renter can report a problem with the account they are holding — most importantly
**"có người khác đăng nhập vào tài khoản"**, which means a previous renter kept the
password. `POST /api/rent/report` with `{orderCode, reason, message}`; the control
sits under the credentials on `/thuegame/theisle`.

Reasons live in `src/lib/reports.js`. `intruder` and `wrong_password` are treated
as **urgent**: those two mean the account is compromised, not merely inconvenient.

The panel shows open reports at `/admin` above "sắp hết hạn" — a countdown is a
schedule, a report is somebody stuck right now — with a stat tile alongside.
`GET /api/admin/reports` (add `?all=1` for resolved ones) and
`POST /api/admin/reports/resolve` with `{id, resolution}`.

Behaviour worth knowing:

- **Stored, not just announced.** A Telegram ping nobody reads is gone; the row
  stays until someone resolves it. The push is best-effort on top, and a failed
  send never makes the renter think their report did not go through.
- **Ownership is checked on `user_key`**, and a report against someone else's order
  returns the same 404 as one that does not exist, so the endpoint cannot be used
  to probe which order codes are real.
- **One open report per order** (a partial unique index). A renter pressing the
  button twice updates their report instead of queueing a second ticket.
- **Reportable for 48h after expiry**, since an intrusion is often noticed late,
  but not forever — old orders would otherwise become a spam surface.
- **Scoped like stock.** A manager sees and resolves reports about their own groups
  only; `resolved_by` records the actual signed-in address.
- An urgent report offers the rotation command for that exact account, because
  changing the password is the actual remedy.

## Expiry reminders to renters (Resend)

The Telegram alert above tells *you* a rental ended. This tells the **customer**
it is about to, a few hours ahead, so they can save progress or extend instead of
being cut off mid-session.

```bash
node scripts/send-expiry-reminders.mjs --remote            # dry run: who would be mailed
node scripts/send-expiry-reminders.mjs --remote --send      # actually email them
node scripts/send-expiry-reminders.mjs --test you@you.com   # one email to yourself
```

Nothing is sent without `--send`; a dry run prints the recipients and the exact
message. `--send --remote` asks for typed confirmation unless `--yes` is passed
(use that for cron). `--hours` sets the window, default **3**, max 168.

```bash
wrangler secret put RESEND_API_KEY     # https://resend.com/api-keys
```

```
# .dev.vars — the from-domain must be verified in Resend or the API answers 403
RESEND_FROM=FunGaming VN <no-reply@fungamingvn.shop>
RESEND_REPLY_TO=hotro@fungamingvn.shop
```

Behaviour worth knowing:

- **One BCC blast per 50 recipients**, so customers never see each other's
  addresses. Resend documents `to` as max 50 and says nothing about `bcc`, so it
  is chunked at 50 too rather than assuming.
- **One email per person, not per rental.** Someone renting three accounts is a
  single recipient, and all three orders are marked together.
- **Split into two blasts by rental count.** BCC leaves no room to say *which*
  account is ending, so renters holding several get wording that admits it
  ("có tài khoản sẽ hết hạn" plus "đăng nhập để xem tài khoản nào") instead of a
  message implying they have only one. Each group is chunked separately, so a
  group never exceeds the BCC cap by riding along with the other. Preview it with
  `--test you@you.com --many true`.
- **The message is generic on purpose.** BCC means one shared body, so there is no
  per-person expiry time — and deliberately **no credentials**, which would
  otherwise sit in an inbox long after the rental ended. The exact time and the
  extend button are behind the customer's own login.
- **One reminder per customer, not per rental.** An address emailed within
  `--cooldown` hours (default 24) is held back, whichever rental triggered it.
  Without this, someone whose three rentals expire hours apart gets a fresh email
  each time the next one enters the window — a different order each time, but an
  identical-looking message, which reads as spam. The run prints who was held back
  and when they become eligible again.
- **Emailed exactly once.** `orders.reminder_sent_at` (migration `0006`) is the
  marker, separate from `notified_at` so the two messages cannot silence each
  other. Each batch also carries an `Idempotency-Key`, which Resend honours for
  24h, so even a crash mid-run cannot produce two emails. As a last check the run
  refuses to send at all if any address somehow appears in two batches.
- **A failed batch stays due** and exits non-zero; only accepted batches are marked.
- **Apple sign-in allows no email**, so those rentals are skipped rather than
  producing an empty recipient. Warn those customers on the page instead.
- Migration `0006` backfills everything that is not a live rental, so switching
  this on cannot mail people about rentals that are already over.

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
