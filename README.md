# POE Skins — Cloudflare Worker

A simple Worker that serves the four POE Twitch Drops pages with clean URLs.

## Routes

| Path         | Page              |
| ------------ | ----------------- |
| `/`          | Full pack         |
| `/skins`     | Full pack         |
| `/skins2`    | Medium pack       |
| `/skinsOLD`  | Old pack          |
| `/POE2`      | POE 2 pack        |

All image / CSS / JS assets are hot-linked from `saydis.pro`.

## Deploy

Requires Node.js 18+ and the Cloudflare CLI (`wrangler`).

```bash
# 1. Install wrangler if you don't have it
npm install -g wrangler

# 2. Log in to your Cloudflare account
wrangler login

# 3. Test locally (http://localhost:8787)
wrangler dev

# 4. Publish to Cloudflare
wrangler deploy
```

After `wrangler deploy`, your Worker will be live at
`https://poe-skins.<your-subdomain>.workers.dev`.

## Structure

```
.
├── assets/             # Static HTML files served by the Worker
│   ├── skins.html
│   ├── skins2.html
│   ├── skinsOLD.html
│   └── POE2.html
├── src/
│   └── index.js        # Worker entrypoint
├── wrangler.toml       # Cloudflare config
└── README.md
```

## Customising

To change the project name shown in your Cloudflare dashboard, edit the
`name` field in `wrangler.toml` before running `wrangler deploy`.
# twitch
