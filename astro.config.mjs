import { defineConfig } from 'astro/config';
import { readFileSync } from 'node:fs';
import { generateAdvice } from './src/lib/advisor.js';
import { AUTH_PATHS, handleAuthRequest } from './src/lib/auth.js';

// Parse .dev.vars (wrangler's local-secrets file, KEY=value) so `npm run dev`
// can reach Gemini with the same key used by `wrangler dev`.
function loadDevVars() {
  try {
    const txt = readFileSync(new URL('./.dev.vars', import.meta.url), 'utf8');
    const vars = {};
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return vars;
  } catch {
    return {};
  }
}

// Serves POST /api/advisor in the Astro dev server, mirroring the Cloudflare
// Worker so the AI advisor widget works under `npm run dev`. Dev-only — the
// production endpoint lives in worker/index.js. Both call src/lib/advisor.js.
const advisorDevMiddleware = {
  name: 'advisor-dev-api',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
      if (path !== '/api/advisor') return next();

      const sendJson = (status, body) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body));
      };

      if (req.method !== 'POST') return sendJson(405, { error: 'method_not_allowed' });

      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', async () => {
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return sendJson(400, { error: 'invalid_json' });
        }
        const env = { ...process.env, ...loadDevVars() };
        const { status, body: out } = await generateAdvice({
          messages: body?.messages,
          apiKey: env.GEMINI_API_KEY,
          model: env.GEMINI_MODEL,
        });
        sendJson(status, out);
      });
    });
  },
};

// Serves /api/auth/* in the Astro dev server, mirroring the Cloudflare Worker
// so Google Sign-In on /game works under `npm run dev`. Dev-only — the
// production endpoints live in worker/index.js. Both call src/lib/auth.js.
const authDevMiddleware = {
  name: 'auth-dev-api',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
      if (!AUTH_PATHS.includes(path)) return next();

      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', async () => {
        let body = null;
        if (req.method === 'POST') {
          try {
            body = JSON.parse(raw || '{}');
          } catch {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            return res.end(JSON.stringify({ error: 'invalid_json' }));
          }
        }

        const env = { ...process.env, ...loadDevVars() };
        const { status, body: out, cookie } = await handleAuthRequest({
          path,
          method: req.method,
          body,
          cookie: req.headers.cookie,
          secure: false, // dev server is plain http://localhost
          env,
        });

        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        if (cookie) res.setHeader('set-cookie', cookie);
        res.end(JSON.stringify(out));
      });
    });
  },
};

// The rental endpoints need a D1 binding, which only the Worker runtime has.
// Answer them explicitly so `npm run dev` shows a clear reason rather than the
// HTML 404 page arriving where the page expects JSON.
const rentalDevMiddleware = {
  name: 'rentals-dev-stub',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
      if (!path.startsWith('/api/rent/') && path !== '/api/payos/webhook') return next();
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: 'rentals_require_wrangler_dev',
          hint: 'Rentals need the D1 binding. Run: npm run build && npx wrangler dev --local',
        })
      );
    });
  },
};

// Static .html files in public/ that need a clean URL. (/game is an Astro page
// — the dev server already serves it at /game — so it is not listed here; the
// Worker maps it to the built /game.html in production.)
const cleanRoutes = {
  '/skins': '/skins.html',
  '/skins2': '/skins2.html',
  '/skins3': '/skins.html',
  '/skinsOLD': '/skinsOLD.html',
  '/POE2': '/POE2.html',
  '/poe2': '/POE2.html',
};

const cleanUrlMiddleware = {
  name: 'clean-url-rewriter',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (!req.url) return next();
      const [path, query] = req.url.split('?');
      const stripped = path.replace(/\/+$/, '') || '/';
      const target = cleanRoutes[stripped];
      if (target) {
        req.url = query ? `${target}?${query}` : target;
      }
      next();
    });
  },
};

export default defineConfig({
  site: 'https://fungamingvn.shop',
  outDir: './dist',
  publicDir: './public',
  build: { format: 'file' },
  vite: {
    server: { fs: { allow: ['..'] } },
    plugins: [advisorDevMiddleware, authDevMiddleware, rentalDevMiddleware, cleanUrlMiddleware],
  },
});
