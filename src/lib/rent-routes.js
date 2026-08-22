/**
 * The /api/rent/* endpoints, transport-agnostic — the same split as
 * handleAuthRequest in src/lib/auth.js.
 *
 * It lives here rather than in worker/index.js so the Astro dev server can serve
 * the identical routes. Duplicating the dispatch in both places drifts: this list
 * has gained routes twice already, and a route added to one side only works in
 * production while 404-ing in dev, or the reverse — a difference nobody notices
 * until it wastes an afternoon.
 *
 * @returns {{ status: number, body: object }}
 */

import { readSession } from './auth.js';
import { createCheckout, listOrders, listPlans, rentalsConfigured } from './rentals.js';
import { isMerchantConfigError } from './payos.js';
import { listOwnReports, submitReport } from './reports.js';
import { requestSteamCode } from './steamcode.js';

export const RENT_PREFIX = '/api/rent/';

export async function handleRentRequest({ path, method, body, cookie, origin, env }) {
  if (!rentalsConfigured(env)) return { status: 503, body: { error: 'rentals_not_configured' } };

  const user = () => readSession(cookie, env.SESSION_SECRET);
  const needPost = () => (method === 'POST' ? null : { status: 405, body: { error: 'method_not_allowed' } });
  const needGet = () => (method === 'GET' ? null : { status: 405, body: { error: 'method_not_allowed' } });

  if (path === '/api/rent/plans') {
    const wrong = needGet();
    if (wrong) return wrong;
    // The stock figure is per-viewer: an account reserved for another customer, or
    // tagged for a plan, is free but not free to whoever is reading the page.
    const viewer = await user();
    const catalogue = await listPlans(env, undefined, viewer?.email ?? null);
    return catalogue ? { status: 200, body: catalogue } : { status: 404, body: { error: 'unknown_game' } };
  }

  if (path === '/api/rent/checkout') {
    const wrong = needPost();
    if (wrong) return wrong;
    const who = await user();
    if (!who) return { status: 401, body: { error: 'unauthorized' } };
    try {
      return await createCheckout(env, {
        user: who,
        gameId: body?.game,
        planId: body?.planId,
        origin,
        // Present => act on the rental with this order code rather than claiming a
        // new account. Ownership is verified server-side.
        extendOrderCode: body?.extendOrderCode,
        buyOrderCode: body?.buyOrderCode,
        // Move that rental onto a dearer plan, charging the difference.
        upgradeOrderCode: body?.upgradeOrderCode,
        // How many accounts to rent in this one payment (1..10).
        quantity: body?.quantity,
      });
    } catch (err) {
      // Surface it in `wrangler tail` — the shop owner needs payOS's actual
      // complaint, not a generic failure.
      console.error('checkout failed:', err?.message || err);
      return {
        status: 502,
        body: {
          error: 'checkout_failed',
          // A shop-side misconfiguration is not something the customer can act on,
          // so the page shows an apology instead of payOS's merchant text.
          merchantConfig: isMerchantConfigError(err),
          payosCode: err?.payosCode ?? null,
          reason: String(err.message || err),
        },
      };
    }
  }

  if (path === '/api/rent/orders') {
    const wrong = needGet();
    if (wrong) return wrong;
    const who = await user();
    if (!who) return { status: 401, body: { error: 'unauthorized' } };
    return {
      status: 200,
      body: { orders: await listOrders(env, who), reports: await listOwnReports(env, who) },
    };
  }

  // Hands the renter their own Steam Guard code. Guarded hard in steamcode.js:
  // Steam sends the same-looking email for signing in and for changing
  // credentials, and only the latter is a takeover.
  if (path === '/api/rent/steam-code') {
    const wrong = needPost();
    if (wrong) return wrong;
    const who = await user();
    if (!who) return { status: 401, body: { error: 'unauthorized' } };
    return requestSteamCode(env, who, body?.orderCode);
  }

  // A renter reporting a problem with the account they hold — most importantly
  // "someone else is logged in", which means the password is out.
  if (path === '/api/rent/report') {
    const wrong = needPost();
    if (wrong) return wrong;
    const who = await user();
    if (!who) return { status: 401, body: { error: 'unauthorized' } };
    return submitReport(env, who, {
      orderCode: body?.orderCode,
      reason: body?.reason,
      message: body?.message,
    });
  }

  return { status: 404, body: { error: 'not_found' } };
}
