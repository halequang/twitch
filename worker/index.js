/**
 * Cloudflare Worker — POE skins viewer
 *
 * Routes clean paths to the bundled HTML files.
 * Anything else is delegated to the static assets binding.
 */

const ROUTES = {
  "/":          "/index.html",
  "/skins":     "/skins.html",
  "/skins2":    "/skins2.html",
  "/skins3":    "/skins.html",     // no skins3 file exists; fall back to full pack
  "/skinsOLD":  "/skinsOLD.html",
  "/poe2":      "/POE2.html",
  "/POE2":      "/POE2.html",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname.replace(/\/+$/, "") || "/";

    // Map clean path to asset file
    const target = ROUTES[path];
    if (target) {
      const assetUrl = new URL(target, url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // Anything else (favicon, direct .html, etc.) → static assets
    return env.ASSETS.fetch(request);
  },
};
