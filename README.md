# POE Skins — Astro + Cloudflare Worker

Landing page built with [Astro](https://astro.build) and deployed as a Cloudflare Worker.
Skin pages are bundled as static assets.

## Routes

| Path         | Source                                | Description       |
| ------------ | ------------------------------------- | ----------------- |
| `/`          | `src/pages/index.astro`               | Landing page      |
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
│   ├── pages/index.astro   # Landing page
│   └── styles/global.css
├── worker/index.js         # Cloudflare Worker entrypoint (clean-URL routing)
├── notion-content/         # Notion mirror archive (read-only reference)
├── astro.config.mjs
├── wrangler.toml
└── package.json
```

## Customising the worker

The worker (`worker/index.js`) maps clean URLs (`/skins` → `/skins.html`) to files in
the built `dist/` directory. To change the Worker name in Cloudflare, edit the
`name` field in `wrangler.toml` before running `npm run deploy`.
