/**
 * Cloudflare Worker — POE skins static site + AI buy advisor.
 *
 * Maps clean paths to bundled HTML; everything else falls through to the static
 * assets binding. (The mail reader + admin tooling and their /api/* endpoints
 * were split out into the separate `poe-mail` project — mail.fungamingvn.shop.)
 *
 * Adds POST /api/advisor — a Gemini-backed shopping assistant that recommends
 * which product a customer should buy. Reads the GEMINI_API_KEY secret
 * (set with `wrangler secret put GEMINI_API_KEY`) and optional GEMINI_MODEL var.
 * The advice logic is shared with the Astro dev server (see src/lib/advisor.js).
 *
 * Adds /api/auth/* — Google + Apple sign-in for the /game member page. Reads the
 * GOOGLE_CLIENT_ID / APPLE_CLIENT_ID vars and the SESSION_SECRET secret; logic is
 * shared with the dev server too (see src/lib/auth.js).
 *
 * Adds /api/rent/* — Steam account rentals (The Isle) paid through payOS. Needs
 * the D1 binding `DB`, the PAYOS_* secrets and ACCOUNT_ENC_KEY. These endpoints
 * exist only here, not in the Astro dev server, because they need D1 — use
 * `npm run build && npx wrangler dev --local` to exercise them.
 *
 * Adds /api/admin/* — the shop owner's panel. Ended rentals are announced to the
 * owner over Telegram from a scheduled() handler on a Cron Trigger, so an expiry
 * at 3am is noticed without anyone visiting the site.
 */

import { generateAdvice } from "../src/lib/advisor.js";
import { AUTH_PATHS, handleAuthRequest, readSession } from "../src/lib/auth.js";
import { fulfilOrder, rentalsConfigured, stockByGame } from "../src/lib/rentals.js";
import { handleRentRequest } from "../src/lib/rent-routes.js";
import { verifyWebhook } from "../src/lib/payos.js";
import { ADMIN_PREFIX, handleAdminRequest } from "../src/lib/admin.js";
import { notifyExpiredRentals } from "../src/lib/notify.js";

const ROUTES = {
  "/":          "/index.html",
  "/thuegame/theisle": "/thuegame/theisle.html",
  "/admin":     "/admin.html",
  "/skins":     "/skins.html",
  "/skins2":    "/skins2.html",
  "/skins3":    "/skins.html",
  "/skinsOLD":  "/skinsOLD.html",
  "/poe2":      "/POE2.html",
  "/POE2":      "/POE2.html",
};

// Clean paths that 301 to the mail subdomain (the app now lives there).
// `/mail` and `/mail/foo` → https://mail.fungamingvn.shop and .../foo.
const REDIRECTS = {
  "/mail": "https://mail.fungamingvn.shop",
};

// Renamed pages. Kept permanently rather than dropped: payOS payment links
// created before the rename carry returnUrl=/game?rent=success&orderCode=...,
// and a paying customer must not land on a 404. The query string is preserved so
// the outcome still resolves.
const MOVED = {
  "/game": "/thuegame/theisle",
};

/**
 * Headers added to every response.
 *
 * The member page collects a password and names Steam, Google and Apple, which is
 * also the shape of a phishing page — heuristic scanners cannot tell the difference
 * from the markup alone. These headers are the machine-readable difference:
 * form-action pins credential submission to this origin, so the page provably
 * cannot post a password anywhere else, and base-uri stops an injected <base> from
 * moving it. That is precisely the behaviour a phishing kit needs and this site
 * does not.
 *
 * Deliberately no script-src / style-src / frame-src yet: Google Identity, Apple's
 * JS SDK, payOS's embedded checkout and Google Fonts all load cross-origin, and a
 * wrong value there breaks sign-in or payment. The origins involved are
 * accounts.google.com, appleid.cdn-apple.com, api-merchant.payos.vn,
 * fonts.googleapis.com and fonts.gstatic.com — tighten in one deliberate step,
 * verified in a browser, not as a side effect of this.
 */
const SECURITY_HEADERS = {
  "content-security-policy": "form-action 'self'; frame-ancestors 'self'; base-uri 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  // No includeSubdomains: subdomains are not audited here, and locking them in is
  // hard to walk back.
  "strict-transport-security": "max-age=15552000",
};

/** Copies a response so headers can be added — asset responses are immutable. */
function withSecurityHeaders(response) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  return out;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handleAdvisor(request, env) {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { status, body: out } = await generateAdvice({
    messages: body?.messages,
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
  });
  return json(out, status);
}

async function handleAuth(request, env, url, path) {
  let body = null;
  if (request.method === "POST") {
    // /api/auth/logout POSTs with no body at all, so an empty body is valid —
    // only malformed JSON is a 400.
    const raw = (await request.text()).trim();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
    }
  }

  const { status, body: out, cookie } = await handleAuthRequest({
    path,
    method: request.method,
    body,
    cookie: request.headers.get("cookie"),
    secure: url.protocol === "https:",
    env,
  });

  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(JSON.stringify(out), { status, headers });
}

/* ─── Steam account rentals ─────────────────────── */

async function requireUser(request, env) {
  return readSession(request.headers.get("cookie"), env.SESSION_SECRET);
}

async function handleRent(request, env, url, path) {
  // The routes themselves live in src/lib/rent-routes.js so the Astro dev server
  // can serve exactly the same ones; this is only the HTTP adapter.
  let body = null;
  if (request.method === "POST") {
    const raw = await request.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
    }
  }

  const { status, body: out } = await handleRentRequest({
    path,
    method: request.method,
    body,
    cookie: request.headers.get("cookie"),
    origin: url.origin,
    env,
  });
  return json(out, status);
}


/**
 * Shop-owner admin panel API. Every route re-checks admin rights inside
 * handleAdminRequest, so this wrapper only has to resolve the session.
 */
async function handleAdmin(request, env, url, path) {
  let body = null;
  if (["POST", "PATCH", "PUT"].includes(request.method)) {
    const raw = (await request.text()).trim();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
    }
  }

  const { status, body: out } = await handleAdminRequest(env, {
    path,
    method: request.method,
    body,
    user: await requireUser(request, env),
    query: Object.fromEntries(url.searchParams),
  });

  return new Response(JSON.stringify(out), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Admin data must never sit in a shared cache.
      "cache-control": "no-store",
    },
  });
}

/**
 * payOS webhook. Signature verification is the only thing standing between a
 * stranger and free Steam credentials, so an unverified body is dropped.
 *
 * Always answers 200: payOS retries on non-2xx, and it also probes this URL
 * with a dummy payload when the webhook is registered.
 */
async function handlePayosWebhook(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "invalid_json" }, 200);
  }

  const data = await verifyWebhook(body, env.PAYOS_CHECKSUM_KEY);
  if (!data) return json({ success: false, error: "bad_signature" }, 200);

  const orderCode = Number(data.orderCode);
  // payOS's registration probe uses a placeholder order that is not ours.
  if (!Number.isFinite(orderCode) || !env.DB) return json({ success: true });

  if (body.success === true || data.code === "00") {
    try {
      await fulfilOrder(env, orderCode);
    } catch {
      // Swallow: returning non-200 makes payOS retry forever. The return-URL
      // reconciliation in listOrders() will pick this order up instead.
    }
  }
  return json({ success: true });
}

export default {
  scheduled: (event, env, ctx) => scheduled(event, env, ctx),

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

    if (path === "/api/advisor") {
      return handleAdvisor(request, env);
    }

    if (AUTH_PATHS.includes(path)) {
      return handleAuth(request, env, url, path);
    }

    if (path === "/api/payos/webhook") {
      return handlePayosWebhook(request, env);
    }

    if (path.startsWith("/api/rent/")) {
      return handleRent(request, env, url, path);
    }

    if (path.startsWith(ADMIN_PREFIX)) {
      return handleAdmin(request, env, url, path);
    }

    const moved = MOVED[path];
    if (moved) {
      return Response.redirect(new URL(moved + url.search, url).toString(), 301);
    }

    for (const [prefix, dest] of Object.entries(REDIRECTS)) {
      if (path === prefix || path.startsWith(prefix + "/")) {
        const rest = path.slice(prefix.length);
        return Response.redirect(dest + rest + url.search, 301);
      }
    }

    const target = ROUTES[path];
    if (target) {
      const assetUrl = new URL(target, url);
      return withSecurityHeaders(await env.ASSETS.fetch(new Request(assetUrl, request)));
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};

/**
 * Cron entrypoint. Expiry is otherwise only noticed lazily, when a customer
 * happens to load /game and sweepExpired() runs — a rental could end at 3am with
 * nobody the wiser. This runs the same sweep on a timer.
 *
 * Sweep FIRST: it is what moves a lapsed rental to 'expired' and returns its
 * account to the pool, which is exactly what the notifier then looks for.
 */
export async function scheduled(event, env, ctx) {
  if (!env.DB) return;
  try {
    await stockByGame(env.DB); // sweeps lapsed rentals back into the pool
    const result = await notifyExpiredRentals(env);
    if (result.found) {
      console.log(
        `expiry notices: found ${result.found}, sent ${result.sent}` +
          (result.skipped ? ` (skipped: ${result.skipped})` : "")
      );
    }
  } catch (err) {
    // Logged, not rethrown: a failing notifier must not stop the next run.
    // Unsent rows stay unmarked and are retried.
    console.error("scheduled expiry check failed:", err?.message || err);
  }
}
