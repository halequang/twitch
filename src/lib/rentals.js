/**
 * Steam account rentals: inventory, orders, and credential release.
 *
 * Storage is Cloudflare D1 (binding `DB`, schema in migrations/0001_rentals.sql).
 * Passwords are encrypted at rest with AES-GCM under ACCOUNT_ENC_KEY so that a
 * database dump on its own does not leak Steam logins.
 *
 * Order lifecycle:
 *   pending ──(payOS says PAID)──▶ active ──(expires_at passes)──▶ expired
 *      │                              ▲
 *      └──(paid but pool empty)──▶ awaiting_stock ─┘
 *
 * Credentials are only ever returned for an `active` order belonging to the
 * requesting session.
 */

import { DEFAULT_GAME, GAMES, findPlan, purchasePlan } from '../data/rental-plans.js';
import {
  createPaymentLink,
  embeddedCheckoutAvailable,
  getPaymentInfo,
  isPaid,
  payosConfigured,
} from './payos.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ─── credential encryption ───────────────────── */

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(input) {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Any passphrase works — it is hashed to a 256-bit AES key.
async function aesKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext, secret) {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  return `${bytesToB64url(iv)}.${bytesToB64url(new Uint8Array(ct))}`;
}

export async function decryptSecret(stored, secret) {
  const [ivPart, ctPart] = String(stored || '').split('.');
  if (!ivPart || !ctPart) throw new Error('bad_ciphertext');
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlToBytes(ivPart) },
    key,
    b64urlToBytes(ctPart)
  );
  return decoder.decode(pt);
}

/* ─── helpers ─────────────────────────────────── */

const now = () => Math.floor(Date.now() / 1000);

// payOS prints the order code in the bank transfer content, so shorter is
// friendlier when a customer reads it out to support. Seconds since 2025-01-01
// gives 8 digits, stays monotonic, and is unique per second — the caller retries
// on the rare same-second collision.
//
// (payOS's own quick-start uses `Number(String(Date.now()).slice(-6))`, which
// wraps every ~16 minutes and will eventually collide. Don't copy that.)
const ORDER_CODE_EPOCH = 1735689600; // 2025-01-01T00:00:00Z

export function nextOrderCode() {
  return now() - ORDER_CODE_EPOCH;
}

export function userKey(user) {
  return `${user.provider || 'unknown'}:${user.sub}`;
}

export function rentalsConfigured(env) {
  return Boolean(env?.DB && env?.ACCOUNT_ENC_KEY && payosConfigured(env));
}

/**
 * Whether renters also receive the account's mailbox (needed to read Steam Guard
 * codes, but it also lets them reset the Steam password and keep the account).
 * Off unless explicitly switched on.
 */
export function releasesEmail(env) {
  const flag = env?.RENTAL_RELEASE_EMAIL;
  return flag === '1' || flag === 'true';
}

/**
 * Returns expired rentals to the pool. Called before anything that reads or
 * allocates stock, so no cron job is needed.
 */
async function sweepExpired(db) {
  const ts = now();
  const expired = await db
    .prepare(`SELECT order_code, account_id FROM orders WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`)
    .bind(ts)
    .all();

  const rows = expired?.results ?? [];
  if (!rows.length) return 0;

  const statements = [
    db.prepare(`UPDATE orders SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`).bind(ts),
  ];
  for (const row of rows) {
    if (row.account_id != null) {
      statements.push(
        db
          .prepare(`UPDATE steam_accounts SET status = 'available' WHERE id = ? AND status = 'rented'`)
          .bind(row.account_id)
      );
    }
  }
  await db.batch(statements);
  return rows.length;
}

/**
 * Public wrapper for the expiry sweep, so callers that only need state to be
 * truthful (the admin panel) can run it without pretending to ask about stock.
 */
export async function sweepExpiredRentals(db) {
  return sweepExpired(db);
}

/**
 * How many accounts this customer could actually be given: the unreserved ones,
 * plus any held aside for them.
 *
 * Counting every 'available' row would over-report — an account reserved for
 * someone else is free but not free *to you*, and promising stock that checkout
 * then refuses as out_of_stock is worse than showing the smaller honest number.
 * With no email (an anonymous page view, or an Apple account without one) this
 * reports the unreserved count.
 */
export async function stockByGame(db, game = DEFAULT_GAME, forEmail = null) {
  await sweepExpired(db);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM steam_accounts
        WHERE game = ? AND status = 'available'
          AND (reserved_for IS NULL OR lower(reserved_for) = lower(?))`
    )
    .bind(game, forEmail ?? '')
    .first();
  return row?.n ?? 0;
}

/**
 * Claims one available account atomically. The nested SELECT inside a single
 * UPDATE ... RETURNING is what stops two simultaneous payments being handed the
 * same login.
 *
 * An account reserved for this customer is taken first, so a returning renter gets
 * their old login back. Failing that, only unreserved accounts are eligible: a
 * reservation would mean nothing if the next stranger could be handed it.
 *
 * Both rules live in one ORDER BY rather than two queries, because two would
 * reopen the race the single statement exists to close.
 */
async function claimAccount(db, game, forEmail = null) {
  const row = await db
    .prepare(
      `UPDATE steam_accounts SET status = 'rented'
        WHERE id = (
          SELECT id FROM steam_accounts
           WHERE game = ? AND status = 'available'
             AND (reserved_for IS NULL OR lower(reserved_for) = lower(?))
           ORDER BY CASE WHEN reserved_for IS NULL THEN 1 ELSE 0 END, id
           LIMIT 1
        )
        RETURNING id`
    )
    .bind(game, forEmail ?? '')
    .first();
  return row?.id ?? null;
}

/* ─── catalogue ───────────────────────────────── */

export async function listPlans(env, game = DEFAULT_GAME, forEmail = null) {
  const catalogue = GAMES[game];
  if (!catalogue) return null;
  // Counted for this viewer, so the number on the page is the number checkout
  // will honour rather than including accounts held for someone else.
  const available = env?.DB ? await stockByGame(env.DB, game, forEmail) : 0;
  return {
    game,
    name: catalogue.name,
    blurb: catalogue.blurb,
    available,
    plans: catalogue.plans,
  };
}

/* ─── checkout ────────────────────────────────── */

// payOS caps the description that reaches the bank transfer, and banks mangle
// non-ASCII. Build the duration from `hours` rather than the Vietnamese label,
// so "24 giờ" becomes "24h" instead of a truncated "24 gi".
function shortDescription(plan, isExtension = false) {
  // payOS caps this at 25 ASCII characters, hence the trimming rather than prose.
  if (plan.purchase) {
    return `Mua acc ${plan.gameName}`.replace(/[^\x20-\x7E]/g, '').slice(0, 25);
  }
  // Only collapse to days beyond one, so the "24 giờ" plan still reads "24h".
  const duration = plan.hours >= 48 && plan.hours % 24 === 0 ? `${plan.hours / 24}d` : `${plan.hours}h`;
  const verb = isExtension ? 'Gia han' : 'Thue';
  return `${verb} ${plan.gameName} ${duration}`.replace(/[^\x20-\x7E]/g, '').slice(0, 25);
}

async function insertOrder(db, order) {
  // order_code is the primary key; on the astronomically unlikely collision the
  // caller retries with a fresh one.
  await db
    .prepare(
      `INSERT INTO orders (order_code, user_key, user_email, game, plan_id, hours, amount, status, created_at, extends_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .bind(
      order.orderCode,
      order.userKey,
      order.userEmail,
      order.game,
      order.planId,
      order.hours,
      order.amount,
      order.createdAt,
      order.extendsOrder ?? null
    )
    .run();
}

export async function createCheckout(
  env,
  { user, gameId = DEFAULT_GAME, planId, origin, extendOrderCode, buyOrderCode }
) {
  const plan = findPlan(gameId, planId);
  if (!plan) return { status: 400, body: { error: 'unknown_plan' } };

  const db = env.DB;
  const key = userKey(user);

  // Buying is only ever offered for a rental the customer is already holding, so
  // there is no way to buy a login they have never had in their hands.
  if (plan.purchase && buyOrderCode == null) {
    return { status: 400, body: { error: 'purchase_needs_rental' } };
  }

  // An extension tops up a rental the customer already holds and a purchase takes
  // it over outright. Both act on an existing order's account, so both reuse it and
  // must NOT be blocked by an empty pool.
  const targetOrderCode = extendOrderCode ?? buyOrderCode;
  let parent = null;
  if (targetOrderCode != null) {
    await sweepExpired(db);
    parent = await db
      .prepare(`SELECT * FROM orders WHERE order_code = ? AND user_key = ?`)
      .bind(Number(targetOrderCode), key)
      .first();
    // Scoped to user_key so one customer cannot extend or buy another's rental.
    if (!parent) return { status: 404, body: { error: 'unknown_order' } };
    if (parent.status !== 'active') {
      return { status: 409, body: { error: 'not_extendable', status: parent.status } };
    }
    if (parent.account_id == null) return { status: 409, body: { error: 'no_account_yet' } };
    gameId = parent.game;
  } else {
    const available = await stockByGame(db, gameId, user?.email ?? null);
    if (available < 1) return { status: 409, body: { error: 'out_of_stock' } };
  }

  // One unpaid checkout at a time keeps the orders table honest and stops a
  // user racking up parallel payment links.
  // One unpaid checkout at a time, per user and per target order — switching
  // between 1 ngày and 1 tuần reuses the same link rather than racking up parallel
  // ones. A purchase gets its own slot though: an extension and a buy-out of the
  // same rental both point at that order, so sharing one would hand back the 50k
  // extension link for a 190k purchase. Keying on plan_id outright would have
  // given every plan its own slot and lost the original guard.
  const buyPlanId = purchasePlan(gameId)?.id ?? null;
  const kindClause = plan.purchase ? 'AND plan_id = ?' : buyPlanId ? 'AND plan_id <> ?' : '';
  const kindBind = plan.purchase ? [plan.id] : buyPlanId ? [buyPlanId] : [];
  const pending = await db
    .prepare(
      `SELECT order_code, checkout_url FROM orders
        WHERE user_key = ? AND status = 'pending' AND created_at > ?
          AND COALESCE(extends_order, 0) = COALESCE(?, 0)
          ${kindClause}`
    )
    .bind(key, now() - 60 * 30, parent ? parent.order_code : null, ...kindBind)
    .first();
  if (pending?.checkout_url) {
    return {
      status: 200,
      body: {
        checkoutUrl: pending.checkout_url,
        orderCode: pending.order_code,
        reused: true,
        embedded: await embeddedCheckoutAvailable(pending.checkout_url),
      },
    };
  }

  // order_code is the primary key. Two checkouts in the same second collide, so
  // walk forward until one sticks.
  const ORDER_CODE_ATTEMPTS = 8;
  let orderCode = nextOrderCode();
  for (let attempt = 0; ; attempt++) {
    try {
      await insertOrder(db, {
        orderCode,
        userKey: key,
        userEmail: user.email ?? null,
        game: gameId,
        planId: plan.id,
        hours: plan.hours,
        amount: plan.amount,
        createdAt: now(),
        extendsOrder: parent ? parent.order_code : null,
      });
      break;
    } catch (err) {
      if (attempt >= ORDER_CODE_ATTEMPTS - 1) throw err;
      orderCode += 1;
    }
  }

  // Where payOS sends the customer back. Comes from the game definition so a
  // route rename cannot silently break returning payers.
  const pagePath = GAMES[gameId]?.path || '/thuegame/theisle';

  let link;
  try {
    link = await createPaymentLink(env, {
      orderCode,
      amount: plan.amount,
      description: shortDescription(plan, Boolean(parent)),
      returnUrl: `${origin}${pagePath}?rent=success&orderCode=${orderCode}`,
      cancelUrl: `${origin}${pagePath}?rent=cancel&orderCode=${orderCode}`,
      expiredAt: now() + 60 * 15,
      // Shown as a line item on the payOS-hosted page. The total must match
      // `amount`, so keep it a single row priced at the full amount.
      items: [{ name: `${plan.gameName} - ${plan.label}`, quantity: 1, price: plan.amount }],
      buyerEmail: user.email ?? undefined,
    });
  } catch (err) {
    // Drop the row we just wrote. Otherwise every failed attempt leaves a
    // phantom "Chờ thanh toán" order that the customer can never continue and
    // that reconciliation keeps asking payOS about.
    await db.prepare(`DELETE FROM orders WHERE order_code = ? AND status = 'pending'`).bind(orderCode).run();
    throw err;
  }

  await db
    .prepare(`UPDATE orders SET payment_link_id = ?, checkout_url = ? WHERE order_code = ?`)
    .bind(link.paymentLinkId ?? null, link.checkoutUrl ?? null, orderCode)
    .run();

  return {
    status: 200,
    body: {
      checkoutUrl: link.checkoutUrl,
      orderCode,
      // Whether payOS will actually serve the in-page form for this merchant.
      embedded: await embeddedCheckoutAvailable(link.checkoutUrl),
    },
  };
}

/* ─── fulfilment ──────────────────────────────── */

/**
 * Marks an order paid and hands it an account. Safe to call more than once —
 * payOS may deliver the same webhook twice, and the return-URL reconciliation
 * can race it.
 */
export async function fulfilOrder(env, orderCode) {
  const db = env.DB;
  const order = await db
    .prepare(`SELECT * FROM orders WHERE order_code = ?`)
    .bind(orderCode)
    .first();
  if (!order) return { ok: false, reason: 'unknown_order' };
  if (
    order.status === 'active' ||
    order.status === 'expired' ||
    order.status === 'extended' ||
    order.status === 'sold'
  ) {
    return { ok: true, order };
  }

  // A purchase also points at a parent order, so it must be checked before the
  // extension branch or a buy-out would top up a rental instead of ending it.
  if (findPlan(order.game, order.plan_id)?.purchase) return fulfilPurchase(env, order);
  if (order.extends_order != null) return fulfilExtension(env, order);

  await sweepExpired(db);
  // order.user_email, not the live session: fulfilment also runs from the payOS
  // webhook, where there is no signed-in user to ask.
  const accountId = await claimAccount(db, order.game, order.user_email ?? null);

  const ts = now();
  if (accountId == null) {
    // Paid, but the pool ran dry. Never silently drop this — it needs a human.
    await db
      .prepare(`UPDATE orders SET status = 'awaiting_stock', paid_at = COALESCE(paid_at, ?) WHERE order_code = ?`)
      .bind(ts, orderCode)
      .run();
    return { ok: false, reason: 'out_of_stock' };
  }

  await db
    .prepare(
      `UPDATE orders SET status = 'active', account_id = ?, paid_at = COALESCE(paid_at, ?), expires_at = ?
        WHERE order_code = ?`
    )
    .bind(accountId, ts, ts + order.hours * 3600, orderCode)
    .run();

  return { ok: true, order: { ...order, status: 'active', account_id: accountId } };
}


/**
 * Applies a paid purchase: the rented login becomes the customer's for good.
 *
 * Three things have to be true afterwards, and each is one statement below:
 *   - the account never goes back in the pool ('sold' is filtered out of every
 *     allocation query, and steam_change_password.py refuses to revive it),
 *   - the rental it replaces stops counting down,
 *   - the buyer keeps seeing the credentials forever.
 *
 * That last one is why expires_at is NULL rather than some distant date: the
 * sweep, the expiry reminder and the "expiring soon" panel all test
 * `expires_at IS NOT NULL`, so a NULL expiry is ignored by each of them instead
 * of relying on a year-2099 sentinel nobody would notice was wrong.
 *
 * Deliberately does NOT sweep first, for the same reason fulfilExtension does not:
 * a sweep could expire the parent and hand its account back to the pool moments
 * before we sell it.
 */
async function fulfilPurchase(env, order) {
  const db = env.DB;
  const ts = now();

  const parent =
    order.extends_order != null
      ? await db.prepare(`SELECT * FROM orders WHERE order_code = ?`).bind(order.extends_order).first()
      : null;

  // Paid for a login we cannot identify: never guess, and never silently swallow
  // the payment.
  if (!parent || parent.user_key !== order.user_key || parent.account_id == null) {
    await db
      .prepare(`UPDATE orders SET status = 'awaiting_stock', paid_at = COALESCE(paid_at, ?) WHERE order_code = ?`)
      .bind(ts, order.order_code)
      .run();
    return { ok: false, reason: 'unknown_parent' };
  }

  const accountId = parent.account_id;

  await db.batch([
    // Unconditional on purpose. Whatever state the row is in, a sold login must
    // never be allocated to anyone else again.
    db.prepare(`UPDATE steam_accounts SET status = 'sold' WHERE id = ?`).bind(accountId),
    db
      .prepare(`UPDATE orders SET status = 'sold', expires_at = NULL WHERE order_code = ?`)
      .bind(parent.order_code),
    db
      .prepare(
        `UPDATE orders SET status = 'active', paid_at = COALESCE(paid_at, ?), account_id = ?, expires_at = NULL
          WHERE order_code = ?`
      )
      .bind(ts, accountId, order.order_code),
  ]);

  return { ok: true, order: { ...order, status: 'active', account_id: accountId }, purchased: true };
}

/**
 * Applies a paid extension: adds the plan's hours to the rental it points at,
 * reusing the same Steam account rather than taking another from the pool.
 *
 * Deliberately does NOT sweep first — a sweep would expire the parent and hand
 * its account back to the pool moments before we top it up.
 */
async function fulfilExtension(env, order) {
  const db = env.DB;
  const ts = now();

  const parent = await db
    .prepare(`SELECT * FROM orders WHERE order_code = ?`)
    .bind(order.extends_order)
    .first();

  if (!parent || parent.user_key !== order.user_key) {
    await db
      .prepare(`UPDATE orders SET status = 'awaiting_stock', paid_at = COALESCE(paid_at, ?) WHERE order_code = ?`)
      .bind(ts, order.order_code)
      .run();
    return { ok: false, reason: 'unknown_parent' };
  }

  let accountId = parent.account_id;

  // The parent may have lapsed while the transfer was settling. If its account
  // is still free, take it back so the customer keeps the same login; if someone
  // else already has it, this needs a human rather than a silent failure.
  if (parent.status !== 'active') {
    const reclaimed = await db
      .prepare(
        `UPDATE steam_accounts SET status = 'rented'
          WHERE id = ? AND status = 'available'
          RETURNING id`
      )
      .bind(parent.account_id)
      .first();
    if (!reclaimed) {
      await db
        .prepare(`UPDATE orders SET status = 'awaiting_stock', paid_at = COALESCE(paid_at, ?) WHERE order_code = ?`)
        .bind(ts, order.order_code)
        .run();
      return { ok: false, reason: 'account_taken' };
    }
    accountId = reclaimed.id;
  }

  // Extend from whichever is later: an unexpired rental keeps its remaining
  // time, a lapsed one restarts from now. Either way no time is lost or gifted.
  const base = parent.status === 'active' && parent.expires_at > ts ? parent.expires_at : ts;
  const expiresAt = base + order.hours * 3600;

  await db.batch([
    db
      .prepare(`UPDATE orders SET status = 'active', expires_at = ?, account_id = ? WHERE order_code = ?`)
      .bind(expiresAt, accountId, parent.order_code),
    db
      .prepare(
        `UPDATE orders SET status = 'extended', paid_at = COALESCE(paid_at, ?), account_id = ?, expires_at = ?
          WHERE order_code = ?`
      )
      .bind(ts, accountId, expiresAt, order.order_code),
  ]);

  return { ok: true, order: { ...order, status: 'extended' }, expiresAt };
}

/**
 * Asks payOS directly whether a pending order has been paid. This is the safety
 * net for a webhook that never arrived — without it a paying customer would sit
 * on "pending" forever.
 */
async function reconcilePending(env, orders) {
  for (const order of orders) {
    if (order.status !== 'pending') continue;
    try {
      const info = await getPaymentInfo(env, order.order_code);
      if (isPaid(info)) {
        await fulfilOrder(env, order.order_code);
      } else if (info?.status === 'CANCELLED' || info?.status === 'EXPIRED') {
        // Kept apart so the page can say "you cancelled" rather than the
        // misleading "your payment link ran out", and vice versa.
        const status = info.status === 'EXPIRED' ? 'payment_expired' : 'cancelled';
        await env.DB.prepare(`UPDATE orders SET status = ? WHERE order_code = ? AND status = 'pending'`)
          .bind(status, order.order_code)
          .run();
      }
      // PENDING / PROCESSING: a bank transfer still in flight. Leave it alone —
      // the client polls, and the webhook usually wins the race anyway.
    } catch {
      // payOS unreachable — leave the order pending and try again next load.
    }
  }
}

/* ─── reading a user's rentals ────────────────── */

export async function listOrders(env, user) {
  const db = env.DB;
  await sweepExpired(db);
  const key = userKey(user);

  const initial = await db
    .prepare(`SELECT * FROM orders WHERE user_key = ? ORDER BY created_at DESC LIMIT 10`)
    .bind(key)
    .all();

  const pending = (initial?.results ?? []).filter((o) => o.status === 'pending');
  if (pending.length) {
    await reconcilePending(env, pending);
  }

  const refreshed = await db
    .prepare(`SELECT * FROM orders WHERE user_key = ? ORDER BY created_at DESC LIMIT 10`)
    .bind(key)
    .all();

  const out = [];
  for (const order of refreshed?.results ?? []) {
    const entry = {
      orderCode: order.order_code,
      game: order.game,
      planId: order.plan_id,
      hours: order.hours,
      amount: order.amount,
      status: order.status,
      extendsOrder: order.extends_order ?? null,
      checkoutUrl: order.status === 'pending' ? order.checkout_url : null,
      createdAt: order.created_at,
      expiresAt: order.expires_at,
      purchase: Boolean(findPlan(order.game, order.plan_id)?.purchase),
      credentials: null,
    };

    // Credentials are released only for this user's own live rental — or, for a
    // purchase, for as long as they own it.
    if (order.status === 'active' && order.account_id != null) {
      const account = await db
        .prepare(
          `SELECT login, password_enc, note, email, email_password_enc FROM steam_accounts WHERE id = ?`
        )
        .bind(order.account_id)
        .first();
      if (account) {
        try {
          entry.credentials = {
            login: account.login,
            password: await decryptSecret(account.password_enc, env.ACCOUNT_ENC_KEY),
            note: account.note ?? null,
          };
          // The mailbox is withheld from renters by default: whoever holds it can
          // reset the Steam password and keep the account for good. For a BUYER
          // that is precisely the point — and it is what makes buying fix the
          // problem the rental page warns about, since logging in to a server's
          // own site for voice chat needs the mailbox to confirm it. So a purchase
          // always includes it; a rental only if you opt in.
          if (entry.purchase || releasesEmail(env)) {
            entry.credentials.email = account.email ?? null;
            entry.credentials.emailPassword = account.email_password_enc
              ? await decryptSecret(account.email_password_enc, env.ACCOUNT_ENC_KEY)
              : null;
          }
        } catch (err) {
          // Almost always an ACCOUNT_ENC_KEY mismatch: the deployed secret is
          // not the one the rows were encrypted with, so a paid customer sees
          // nothing. Say so loudly — this used to fail silently.
          console.error(
            `rental ${order.order_code}: cannot decrypt account ${order.account_id} — ` +
              'ACCOUNT_ENC_KEY likely does not match the key used to import it. ' +
              `(${err?.message || err})`
          );
          entry.credentials = null;
          entry.status = 'error';
        }
      }
    }
    // `internal_note` is never read here — it is shop bookkeeping, not customer text.
    out.push(entry);
  }
  return out;
}
