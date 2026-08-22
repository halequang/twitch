import { defineConfig } from 'astro/config';
import { readFileSync, readdirSync } from 'node:fs';
import { generateAdvice } from './src/lib/advisor.js';
import { AUTH_PATHS, handleAuthRequest } from './src/lib/auth.js';
import { handleRentRequest } from './src/lib/rent-routes.js';
import { ADMIN_PREFIX, handleAdminRequest } from './src/lib/admin.js';
import { readSession } from './src/lib/auth.js';

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

/**
 * A minimal D1 stand-in for `npm run dev`, backed by the very sqlite file
 * `wrangler dev --local` uses.
 *
 * The Astro dev server is plain Node with no D1 binding, so every endpoint that
 * touches the database answered 503 locally — email sign-up included, which is why
 * signing in there reported "Đăng ký bằng email chưa sẵn sàng". Exercising those
 * flows meant a full `npm run build && wrangler dev` cycle for each edit.
 *
 * Implements only what the shared lib calls: prepare → bind → first/all/run, plus
 * batch. Returns null when node:sqlite or the file is unavailable, in which case
 * the endpoints go back to answering 503 with a clear reason.
 *
 * Dev only. Production uses the real binding, and this file is never bundled.
 */
async function localD1() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null; // node < 22
  }

  // miniflare names the file after a hash, so it is found by content rather than
  // by guessing the hash — which changes if the database is recreated.
  const dir = 'node_modules/../.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sqlite'));
  } catch {
    return null; // never run `wrangler dev --local` here
  }

  // More than one miniflare database can carry a steam_accounts table — an older
  // state directory did, without the users table — so the candidates are SCORED on
  // how much of this schema they have rather than taking the first hit. Picking
  // wrong is worse than picking nothing: the endpoint then throws "no such table".
  const WANTED = ['steam_accounts', 'orders', 'users', 'email_codes'];
  let best = null;
  for (const file of files) {
    const full = `${dir}/${file}`;
    try {
      const db = new DatabaseSync(full);
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN (${WANTED.map(
            (t) => `'${t}'`
          ).join(',')})`
        )
        .get();
      const score = row?.n ?? 0;
      if (score && (!best || score > best.score)) {
        if (best) best.db.close();
        best = { db, full, score };
      } else {
        db.close();
      }
    } catch {
      /* try the next one */
    }
  }
  if (!best) return null;
  if (best.score < WANTED.length) {
    console.warn(
      `[dev-d1] ${best.full} is missing some tables (${best.score}/${WANTED.length}). ` +
        'Apply the migrations to the local D1 if an endpoint complains.'
    );
  }
  return wrapD1(best.db, best.full);
}

function wrapD1(db, path) {
  const run = (sql, binds) => {
    const stmt = db.prepare(sql);
    return {
      // D1 returns { results }; node:sqlite returns the array directly.
      all: async () => ({ results: stmt.all(...binds) }),
      first: async () => stmt.get(...binds) ?? null,
      run: async () => {
        // A statement with RETURNING must be stepped, not just executed.
        if (/returning/i.test(sql)) return { results: stmt.all(...binds) };
        stmt.run(...binds);
        return { success: true };
      },
    };
  };
  const prepare = (sql) => ({
    bind: (...binds) => run(sql, binds),
    // Some callers skip bind entirely.
    ...run(sql, []),
  });
  return {
    __localPath: path,
    prepare,
    // D1 batches atomically; sequential is close enough for a dev server, and the
    // alternative is not offering batch at all.
    batch: async (statements) => {
      const out = [];
      for (const st of statements) out.push(await st.run());
      return out;
    },
  };
}

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
        // Without this the email endpoints answer 503 and the page says email
        // sign-up is unavailable — true of the dev server, but only because it
        // never had a database, not because the feature is missing.
        // Anything thrown in here used to leave the request hanging with no
        // response at all — no status, no log line — which is a miserable thing to
        // debug. Answer 500 with the reason instead.
        try {
          const db = await localD1();
          if (db) env.DB = db;
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
        } catch (err) {
          console.error(`[dev-auth] ${path} failed:`, err);
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'dev_handler_failed', reason: String(err?.message || err) }));
        }
      });
    });
  },
};

// Serves /api/rent/* in the Astro dev server. The routes themselves come from
// src/lib/rent-routes.js, the same module the Worker uses, so a route added in one
// place cannot work in production while 404-ing in dev.
const rentalDevMiddleware = {
  name: 'rentals-dev-api',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
      // The webhook is answered too, with a reason rather than the HTML 404 page
      // arriving where the caller expects JSON. payOS cannot reach localhost, so
      // there is nothing to serve — but saying so beats a mystery.
      if (path === '/api/payos/webhook') {
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        return res.end(
          JSON.stringify({
            error: 'webhook_not_served_in_dev',
            hint: 'payOS cannot reach localhost. Use `npx wrangler dev --local` with a tunnel, or fulfil the order by hand.',
          })
        );
      }
      if (!path.startsWith('/api/rent/')) return next();

      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', async () => {
        const send = (status, payload) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify(payload));
        };

        let body = null;
        if (req.method === 'POST' && raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            return send(400, { error: 'invalid_json' });
          }
        }

        // As with the auth middleware: a throw in here would otherwise hang the
        // request with no status and no log line.
        try {
          const env = { ...process.env, ...loadDevVars() };
          const db = await localD1();
          if (db) env.DB = db;
          if (!db) {
            return send(503, {
              error: 'rentals_require_local_d1',
              hint: 'No local D1 found. Run `npx wrangler dev --local` once to create it.',
            });
          }

          // Checkout talks to payOS for real, and .dev.vars holds live merchant
          // keys — so a click on "Thuê ngay" here would create a genuine payment
          // request in the production dashboard. Refuse unless it is pointed at a
          // stub, or the real thing is asked for explicitly.
          if (path === '/api/rent/checkout' && !env.PAYOS_API_BASE_OK) {
            const stubbed = Boolean(env.PAYOS_BASE_URL);
            const forced = env.DEV_REAL_PAYOS === '1';
            if (!stubbed && !forced) {
              return send(503, {
                error: 'dev_checkout_would_hit_real_payos',
                hint:
                  'Set PAYOS_BASE_URL to a stub, or DEV_REAL_PAYOS=1 to create real ' +
                  'payment links from the dev server.',
              });
            }
          }

          const { status, body: out } = await handleRentRequest({
            path,
            method: req.method,
            body,
            cookie: req.headers.cookie,
            origin: `http://${req.headers.host || 'localhost:4321'}`,
            env,
          });
          send(status, out);
        } catch (err) {
          console.error(`[dev-rent] ${path} failed:`, err);
          send(500, { error: 'dev_handler_failed', reason: String(err?.message || err) });
        }
      });
    });
  },
};

// Serves /api/admin/* in the Astro dev server. Without it the panel's own fetches
// answer with the HTML 404 page, #adminPanel never unhides, and the whole thing
// looks broken — filters, tables and all — for want of a route.
const adminDevMiddleware = {
  name: 'admin-dev-api',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const [rawPath, rawQuery] = (req.url || '').split('?');
      const path = rawPath.replace(/\/+$/, '') || '/';
      if (!path.startsWith(ADMIN_PREFIX)) return next();

      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', async () => {
        const send = (status, payload) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify(payload));
        };

        let body = null;
        if (raw && req.method !== 'GET') {
          try {
            body = JSON.parse(raw);
          } catch {
            return send(400, { error: 'invalid_json' });
          }
        }

        try {
          const env = { ...process.env, ...loadDevVars() };
          const db = await localD1();
          if (!db) {
            return send(503, {
              error: 'admin_requires_local_d1',
              hint: 'No local D1 found. Run `npx wrangler dev --local` once to create it.',
            });
          }
          env.DB = db;

          const user = await readSession(req.headers.cookie, env.SESSION_SECRET);
          const { status, body: out } = await handleAdminRequest(env, {
            path,
            method: req.method,
            body,
            user,
            query: Object.fromEntries(new URLSearchParams(rawQuery || '')),
          });
          send(status, out);
        } catch (err) {
          console.error(`[dev-admin] ${path} failed:`, err);
          send(500, { error: 'dev_handler_failed', reason: String(err?.message || err) });
        }
      });
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
    plugins: [
      advisorDevMiddleware,
      authDevMiddleware,
      rentalDevMiddleware,
      adminDevMiddleware,
      cleanUrlMiddleware,
    ],
  },
});
