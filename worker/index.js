/**
 * Cloudflare Worker — POE skins static site.
 *
 * Maps clean paths to bundled HTML; everything else falls through to the static
 * assets binding. (The mail reader + admin tooling and their /api/* endpoints
 * were split out into the separate `poe-mail` project — mail.fungamingvn.shop.)
 */

const ROUTES = {
  "/":          "/index.html",
  "/skins":     "/skins.html",
  "/skins2":    "/skins2.html",
  "/skins3":    "/skins.html",
  "/skinsOLD":  "/skinsOLD.html",
  "/poe2":      "/POE2.html",
  "/POE2":      "/POE2.html",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

    const target = ROUTES[path];
    if (target) {
      const assetUrl = new URL(target, url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }
    return env.ASSETS.fetch(request);
  },
};
