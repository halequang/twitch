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
 */

import { generateAdvice } from "../src/lib/advisor.js";

const ROUTES = {
  "/":          "/index.html",
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

    if (path === "/api/advisor") {
      return handleAdvisor(request, env);
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
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }
    return env.ASSETS.fetch(request);
  },
};