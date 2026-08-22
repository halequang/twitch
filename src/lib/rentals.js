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

import {
  DEFAULT_GAME,
  GAMES,
  TAG_SEPARATORS,
  accountMeetsPlanTags,
  findPlan,
  purchasePlan,
  saleAllowed,
  tagsBarredFrom,
  tagsPreferredBy,
  tagsRequiredBy,
  upgradeAllowed,
  upgradesFrom,
} from '../data/rental-plans.js';
import { hasGuardFlag } from './steamcode.js';
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
// Renting in bulk is one payment for N sibling orders. Ten is the ceiling because
// each one claims a real login out of a pool that is rarely bigger than that, and
// a typo in a quantity box should not be able to empty the shop.
export const MAX_BATCH = 10;

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
/* ─── account tags ────────────────────────────── */

// internal_note is free text, so a tag is matched as a whole token: common
// separators become spaces and the note is padded, turning "a · no_ban" into
// " a no_ban " so '% no_ban %' hits while "no_ban_check" does not. A substring
// match would quietly restrict accounts nobody meant to restrict.
// The separator list — anything that is punctuation around a word rather than part
// of one — lives in data/rental-plans.js beside noteHasTag(), which has to agree
// with this SQL. It is a list because a hand-nested REPLACE chain is where the first
// version went wrong: it stopped at "· , ; |", so a note reading "(day 2, no_ban)"
// was NOT restricted — the closing bracket sat against the tag and it never matched.

const sqlChar = (ch) => `'${ch.replace(/'/g, "''")}'`;

const tagTokenSql = (col) => {
  const normalised = TAG_SEPARATORS.reduce(
    (expr, ch) => `REPLACE(${expr}, ${sqlChar(ch)}, ' ')`,
    `COALESCE(${col}, '')`
  );
  // Padded so a tag at either end still has a space on both sides.
  return `(' ' || ${normalised} || ' ')`;
};

// `prefix` because claimAccount aliases the table as `s`, where an unqualified
// internal_note would be ambiguous; the stock count has no alias.
function tagMatch(tag, prefix = '') {
  // Tags come from a hardcoded map, never from a request — but this is inlined into
  // SQL, so refuse anything that is not a plain token rather than trust that.
  if (!/^[a-z0-9_]+$/.test(tag)) throw new Error(`unsafe account tag: ${tag}`);
  return `${tagTokenSql(`${prefix}internal_note`)} LIKE '% ${tag} %'`;
}

/** ` AND <tag> …` for every tag this plan cannot be fulfilled without. */
function tagRequireSql(planId, prefix = '') {
  const required = planId ? tagsRequiredBy(planId) : [];
  return required.length
    ? ` AND ${required.map((t) => tagMatch(t, prefix)).join(' AND ')}`
    : '';
}

/** ` AND NOT <tag> …` for every tag this plan must not be given. */
function tagBarSql(planId, prefix = '') {
  const barred = planId ? tagsBarredFrom(planId) : [];
  return barred.length
    ? ` AND ${barred.map((t) => `NOT ${tagMatch(t, prefix)}`).join(' AND ')}`
    : '';
}

/** An ORDER BY fragment putting accounts earmarked for this plan first. */
function tagPreferSql(planId, prefix = '') {
  const preferred = planId ? tagsPreferredBy(planId) : [];
  if (!preferred.length) return '';
  return `CASE WHEN ${preferred.map((t) => tagMatch(t, prefix)).join(' OR ')} THEN 0 ELSE 1 END,\n             `;
}

export async function stockByGame(db, game = DEFAULT_GAME, forEmail = null, planId = null) {
  await sweepExpired(db);
  return countStock(db, game, forEmail, planId);
}

/**
 * The same count without the sweep, so a caller wanting one figure per plan does
 * not run the sweep once per plan.
 */
async function countStock(db, game, forEmail, planId) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM steam_accounts
        WHERE game = ? AND status = 'available'
          AND (reserved_for IS NULL OR lower(reserved_for) = lower(?))${tagRequireSql(planId)}${tagBarSql(planId)}`
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
async function claimAccount(db, game, forEmail = null, planId = null) {
  // Tags EXCLUDE as well as prefer: an account tagged for another plan is filtered
  // out entirely, which is what stops a 20k day rental being handed a no_ban
  // account held back for the 80k VOIP week.
  //
  // Pick order, most specific first:
  //   1. reserved for this customer — it was set aside for them by name
  //   2. earmarked for this plan by an internal_note tag — those accounts exist
  //      for this plan, so spend them here rather than leaving them idle
  //   3. stock no manager can claim: ungrouped, or in a group with no manager
  //      attached. The shop's own stock earns before a manager's does, so it is
  //      spent first and theirs is held back until it runs out.
  //   4. lowest id, so the pool cycles predictably
  //
  // Aliased as `s` because the correlated EXISTS has to point at the row being
  // considered, not at the table the UPDATE is walking.
  const row = await db
    .prepare(
      `UPDATE steam_accounts SET status = 'rented'
        WHERE id = (
          SELECT s.id FROM steam_accounts s
           WHERE s.game = ? AND s.status = 'available'
             AND (s.reserved_for IS NULL OR lower(s.reserved_for) = lower(?))${tagRequireSql(planId, 's.')}${tagBarSql(planId, 's.')}
           ORDER BY
             CASE WHEN s.reserved_for IS NULL THEN 1 ELSE 0 END,
             ${tagPreferSql(planId, 's.')}
             CASE WHEN EXISTS (
               SELECT 1 FROM manager_groups mg WHERE mg.group_id = s.group_id
             ) THEN 1 ELSE 0 END,
             s.id
           LIMIT 1
        )
        RETURNING id`
    )
    .bind(game, forEmail ?? '')
    .first();
  return row?.id ?? null;
}

/* ─── catalogue ───────────────────────────────── */

/**
 * When a plan is empty, when its accounts come back.
 *
 * A forecast, not a promise: the renter holding an account can extend, and an
 * account can be sold or disabled before it returns. So this reports the rentals
 * that WOULD release an eligible account, and the page says "dự kiến".
 *
 * Filtered by the same rules as the stock count, or the forecast would promise
 * accounts this plan still could not be given — an account tagged for another plan,
 * or held for another customer, is not coming back to THIS viewer.
 */
async function forecastForPlan(db, game, forEmail, planId, limit = 3) {
  const rows = await db
    .prepare(
      `SELECT o.expires_at AS at, COUNT(*) AS n
         FROM orders o JOIN steam_accounts a ON a.id = o.account_id
        WHERE o.status = 'active'
          AND o.expires_at IS NOT NULL
          AND o.expires_at > ?
          AND a.game = ?
          -- 'rented' only: a sold or disabled account never returns to the pool, so
          -- counting its rental would forecast stock that cannot arrive.
          AND a.status = 'rented'
          AND (a.reserved_for IS NULL OR lower(a.reserved_for) = lower(?))${tagRequireSql(planId, 'a.')}${tagBarSql(planId, 'a.')}
        GROUP BY o.expires_at
        ORDER BY o.expires_at
        LIMIT ?`
    )
    .bind(now(), game, forEmail ?? '', limit)
    .all();
  return (rows?.results ?? []).map((r) => ({ at: r.at, count: r.n }));
}

export async function listPlans(env, game = DEFAULT_GAME, forEmail = null) {
  const catalogue = GAMES[game];
  if (!catalogue) return null;

  // Stock is per viewer AND per plan: an account can be held for another customer,
  // or tagged for a plan other than this one. A single figure would advertise
  // accounts a given plan cannot be given, and checkout would then refuse them as
  // out_of_stock — worse than showing the smaller honest number.
  //
  // The sweep runs once here rather than once per plan.
  let plans = catalogue.plans.map((p) => ({ ...p, available: 0 }));
  let available = 0;
  if (env?.DB) {
    await sweepExpiredRentals(env.DB);
    plans = await Promise.all(
      catalogue.plans.map(async (p) => {
        const count = await countStock(env.DB, game, forEmail, p.id);
        return {
          ...p,
          available: count,
          // Only worth the query when there is nothing to sell: a customer looking
          // at stock does not need to know when more arrives.
          upcoming: count === 0 ? await forecastForPlan(env.DB, game, forEmail, p.id) : [],
        };
      })
    );
    // The headline figure is what this viewer could rent on their best plan, so
    // "hết tài khoản" only ever means every plan is empty.
    available = plans.reduce((max, p) => Math.max(max, p.available), 0);
  }

  return {
    game,
    name: catalogue.name,
    blurb: catalogue.blurb,
    available,
    plans,
  };
}

/* ─── upgrades ────────────────────────────────── */

/**
 * What moving a live rental onto a dearer plan costs, and how long it then runs.
 *
 * Money: the difference between the two shelf prices, and nothing else. A day
 * upgraded to a week costs 50k − 20k = 30k, so the customer ends up having paid
 * exactly the week's price for a week — which is the only rule that is obvious on
 * the invoice and cannot be argued with. No credit for time already used, and no
 * proration: those are the same number here, because the time is measured from the
 * original start rather than from the moment they upgrade.
 *
 * Time: the new plan's full duration counted from when the rental began, never less
 * than it already had. Upgrading a day-old rental to a week therefore leaves six
 * days, not seven — they are buying "a week of access", not "a week starting now",
 * and the price they paid is exactly a week's. The `Math.max` is the guard that
 * makes it honest: a rental extended past that point keeps every hour it holds, so
 * an upgrade can never take time away.
 */
function upgradeQuote(fromPlan, toPlan, parent, ts) {
  const amount = toPlan.amount - fromPlan.amount;
  // The rental's own clock started when it was paid for; created_at is the fallback
  // for the rows old enough to predate paid_at being written.
  const startedAt = parent.paid_at ?? parent.created_at ?? ts;
  const held = parent.expires_at ?? ts;
  return {
    amount,
    hours: toPlan.hours,
    expiresAt: Math.max(held, startedAt + toPlan.hours * 3600),
  };
}

/* ─── checkout ────────────────────────────────── */

// payOS caps the description that reaches the bank transfer, and banks mangle
// non-ASCII. Build the duration from `hours` rather than the Vietnamese label,
// so "24 giờ" becomes "24h" instead of a truncated "24 gi".
function shortDescription(plan, isExtension = false, count = 1, isUpgrade = false) {
  // payOS caps this at 25 ASCII characters, hence the trimming rather than prose.
  if (plan.purchase) {
    return `Mua acc ${plan.gameName}`.replace(/[^\x20-\x7E]/g, '').slice(0, 25);
  }
  // Only collapse to days beyond one, so the "24 giờ" plan still reads "24h".
  const duration = plan.hours >= 48 && plan.hours % 24 === 0 ? `${plan.hours / 24}d` : `${plan.hours}h`;
  // "Nang cap" rather than "Gia han": the amount is a part-price, and a customer
  // querying a 30k line on their statement needs to see which of the two it was.
  const verb = isUpgrade ? 'Nang cap' : isExtension ? 'Gia han' : 'Thue';
  // The multiplier matters on a bank statement: "x3" is the difference between the
  // customer recognising the amount and disputing it.
  const times = count > 1 ? ` x${count}` : '';
  return `${verb} ${plan.gameName} ${duration}${times}`.replace(/[^\x20-\x7E]/g, '').slice(0, 25);
}

async function insertOrder(db, order) {
  // order_code is the primary key; on the astronomically unlikely collision the
  // caller retries with a fresh one.
  await db
    .prepare(
      `INSERT INTO orders (order_code, user_key, user_email, game, plan_id, hours, amount, status, created_at, extends_order, batch_of, upgrades_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
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
      order.extendsOrder ?? null,
      order.batchOf ?? null,
      order.upgradesOrder ?? null
    )
    .run();
}

export async function createCheckout(
  env,
  { user, gameId = DEFAULT_GAME, planId, origin, extendOrderCode, buyOrderCode, upgradeOrderCode, quantity }
) {
  const plan = findPlan(gameId, planId);
  if (!plan) return { status: 400, body: { error: 'unknown_plan' } };

  // Quantity is validated, not clamped: silently charging for 10 when someone
  // asked for 50 is worse than telling them the limit.
  let count = 1;
  if (quantity !== undefined && quantity !== null && quantity !== '') {
    count = Number(quantity);
    if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
      return { status: 400, body: { error: 'bad_quantity', max: MAX_BATCH } };
    }
  }

  const db = env.DB;
  const key = userKey(user);

  // Buying is only ever offered for a rental the customer is already holding, so
  // there is no way to buy a login they have never had in their hands.
  if (plan.purchase && buyOrderCode == null) {
    return { status: 400, body: { error: 'purchase_needs_rental' } };
  }

  if (count > 1 && (extendOrderCode != null || buyOrderCode != null || upgradeOrderCode != null)) {
    // Each acts on one specific existing rental, so a quantity has nothing to mean.
    return { status: 400, body: { error: 'quantity_not_supported_here' } };
  }

  // Two of these at once is a contradiction — an upgrade replaces the plan, an
  // extension keeps it — and silently picking one would charge for the other.
  if ([extendOrderCode, buyOrderCode, upgradeOrderCode].filter((c) => c != null).length > 1) {
    return { status: 400, body: { error: 'conflicting_target' } };
  }

  // An extension tops up a rental the customer already holds and a purchase takes
  // it over outright. Both act on an existing order's account, so both reuse it and
  // must NOT be blocked by an empty pool.
  const targetOrderCode = extendOrderCode ?? buyOrderCode ?? upgradeOrderCode;
  let parent = null;
  // { quote, swapsAccount } once an upgrade has been validated; null otherwise.
  let upgrade = null;
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
    // Only a no_ban account is for sale (SALE_REQUIRED_TAGS). listOrders already
    // hides the button on the rest, but a hidden button is not a closed endpoint —
    // and selling the wrong account is irreversible, since the buyer gets the
    // mailbox. So the rule is enforced here too, before any money moves.
    if (plan.purchase) {
      const held = await db
        .prepare(`SELECT internal_note FROM steam_accounts WHERE id = ?`)
        .bind(parent.account_id)
        .first();
      if (!saleAllowed(held?.internal_note)) {
        return { status: 409, body: { error: 'not_for_sale' } };
      }
    }

    if (upgradeOrderCode != null) {
      const fromPlan = findPlan(parent.game, parent.plan_id);
      if (!fromPlan) return { status: 409, body: { error: 'unknown_parent_plan' } };
      // The ladder is checked here and not only in the page: the page can be edited
      // by whoever is reading it, and a request naming any pair of plans would
      // otherwise be honoured — including a downgrade, which would charge a
      // negative difference.
      if (!upgradeAllowed(parent.plan_id, plan.id)) {
        return {
          status: 409,
          body: { error: 'upgrade_not_allowed', from: parent.plan_id, to: plan.id, allowed: upgradesFrom(parent.plan_id) },
        };
      }
      upgrade = { quote: upgradeQuote(fromPlan, plan, parent, now()), swapsAccount: false };
      // Prices are edited by hand in rental-plans.js, so a pair that no longer has
      // a gap between them would ask payOS to take 0đ — which it refuses with a
      // less helpful message than this one.
      if (upgrade.quote.amount <= 0) {
        return { status: 409, body: { error: 'upgrade_not_payable', amount: upgrade.quote.amount } };
      }

      // The VOIP week can only be served by a vetted no_ban account, so a rental on
      // an ordinary one has to move to a different login. Checked BEFORE the money
      // moves: discovering it after payment leaves a customer paid-up on a plan the
      // shop cannot serve, which is a refund conversation.
      const held = await db
        .prepare(`SELECT internal_note FROM steam_accounts WHERE id = ?`)
        .bind(parent.account_id)
        .first();
      upgrade.swapsAccount = !accountMeetsPlanTags(held?.internal_note, plan.id);
      if (upgrade.swapsAccount) {
        const available = await stockByGame(db, parent.game, user?.email ?? null, plan.id);
        if (available < 1) return { status: 409, body: { error: 'out_of_stock', available, wanted: 1 } };
      }
    }
    gameId = parent.game;
  } else {
    const available = await stockByGame(db, gameId, user?.email ?? null, plan.id);
    // Checked against the whole batch: taking payment for ten and finding two is a
    // refund conversation, so it is refused before the money moves.
    if (available < count) {
      return { status: 409, body: { error: 'out_of_stock', available, wanted: count } };
    }
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
  // An upgrade and an extension of the same rental both point at it through
  // extends_order, so without this they would share one slot — and the customer
  // clicking "nâng cấp" after opening an extension would be handed back the
  // extension's link, paying the wrong amount for the wrong thing.
  const pending = await db
    .prepare(
      `SELECT order_code, checkout_url FROM orders
        WHERE user_key = ? AND status = 'pending' AND created_at > ?
          AND batch_of IS NULL
          AND COALESCE(extends_order, 0) = COALESCE(?, 0)
          AND COALESCE(upgrades_order, 0) = COALESCE(?, 0)
          ${kindClause}`
    )
    .bind(key, now() - 60 * 30, parent ? parent.order_code : null, upgradeOrderCode ?? null, ...kindBind)
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

  // What this payment actually charges. Every plan is billed at its shelf price
  // except an upgrade, which is billed the gap between two of them.
  const unitAmount = upgrade ? upgrade.quote.amount : plan.amount;

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
        amount: unitAmount,
        createdAt: now(),
        extendsOrder: parent ? parent.order_code : null,
        // Set on an upgrade only, and alongside extends_order rather than instead
        // of it — see migrations/0013_order_upgrade.sql.
        upgradesOrder: upgrade ? parent.order_code : null,
      });
      break;
    } catch (err) {
      if (attempt >= ORDER_CODE_ATTEMPTS - 1) throw err;
      orderCode += 1;
    }
  }

  // The rest of the batch. Each is a full order carrying its own price and its own
  // account, so revenue, expiry and credentials all work per row exactly as a
  // single rental does — only the payment is shared.
  const siblings = [];
  for (let i = 1; i < count; i++) {
    let code = orderCode + i;
    for (let attempt = 0; ; attempt++) {
      try {
        await insertOrder(db, {
          orderCode: code,
          userKey: key,
          userEmail: user.email ?? null,
          game: gameId,
          planId: plan.id,
          hours: plan.hours,
          amount: plan.amount,
          createdAt: now(),
          extendsOrder: null,
          batchOf: orderCode,
        });
        siblings.push(code);
        break;
      } catch (err) {
        if (attempt >= ORDER_CODE_ATTEMPTS - 1) throw err;
        code += 1;
      }
    }
  }

  // Where payOS sends the customer back. Comes from the game definition so a
  // route rename cannot silently break returning payers.
  const pagePath = GAMES[gameId]?.path || '/thuegame/theisle';

  let link;
  try {
    link = await createPaymentLink(env, {
      orderCode,
      amount: unitAmount * count,
      description: shortDescription(plan, Boolean(parent), count, Boolean(upgrade)),
      returnUrl: `${origin}${pagePath}?rent=success&orderCode=${orderCode}`,
      cancelUrl: `${origin}${pagePath}?rent=cancel&orderCode=${orderCode}`,
      expiredAt: now() + 60 * 15,
      // Shown as a line item on the payOS-hosted page. The total must match
      // `amount`, so keep it a single row priced at the full amount.
      items: [{ name: `${plan.gameName} - ${plan.label}`, quantity: count, price: unitAmount }],
      buyerEmail: user.email ?? undefined,
    });
  } catch (err) {
    // Drop the row we just wrote. Otherwise every failed attempt leaves a
    // phantom "Chờ thanh toán" order that the customer can never continue and
    // that reconciliation keeps asking payOS about.
    await db.prepare(`DELETE FROM orders WHERE order_code = ? AND status = 'pending'`).bind(orderCode).run();
    // The siblings would otherwise be unreachable: they carry no payment link of
    // their own and nothing would ever resolve them.
    if (siblings.length) {
      await db
        .prepare(`DELETE FROM orders WHERE batch_of = ? AND status = 'pending'`)
        .bind(orderCode)
        .run();
    }
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
      quantity: count,
      amount: unitAmount * count,
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
/**
 * Fulfils one order, then every sibling that was paid for alongside it.
 *
 * Only the lead carries a payment link, so payOS only ever names the lead — the
 * webhook and the return-URL poll both arrive with its code. Without this the
 * siblings would sit 'pending' forever against a payment that had already cleared.
 *
 * Each sibling goes through the ordinary single-account path, so a batch is N
 * normal rentals rather than a special case the sweep or the extender has to know
 * about. If the pool runs dry part-way the remainder land on 'awaiting_stock',
 * which already means "paid, needs a human" — better than failing the whole batch
 * and leaving the customer with nothing.
 */
export async function fulfilOrder(env, orderCode) {
  const result = await fulfilSingle(env, orderCode);

  const siblings = await env.DB
    .prepare(`SELECT order_code FROM orders WHERE batch_of = ? AND status = 'pending'`)
    .bind(orderCode)
    .all();
  for (const row of siblings?.results ?? []) {
    await fulfilSingle(env, row.order_code);
  }
  return result;
}

async function fulfilSingle(env, orderCode) {
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
    order.status === 'sold' ||
    // The rental this one was moved off. It was paid for, so a redelivered webhook
    // naming it must not fall through to the claim path and take a second account.
    order.status === 'upgraded'
  ) {
    return { ok: true, order };
  }

  // A purchase also points at a parent order, so it must be checked before the
  // extension branch or a buy-out would top up a rental instead of ending it.
  if (findPlan(order.game, order.plan_id)?.purchase) return fulfilPurchase(env, order);
  // Likewise an upgrade: it carries extends_order too, and falling through would
  // add a week's hours to the old plan instead of moving the rental onto the new
  // one — for the price of the difference.
  if (order.upgrades_order != null) return fulfilUpgrade(env, order);
  if (order.extends_order != null) return fulfilExtension(env, order);

  await sweepExpired(db);
  // order.user_email, not the live session: fulfilment also runs from the payOS
  // webhook, where there is no signed-in user to ask.
  const accountId = await claimAccount(db, order.game, order.user_email ?? null, order.plan_id);

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
 * Applies a paid upgrade: the child order becomes the rental, on the new plan, and
 * the parent closes as 'upgraded'.
 *
 * The child has to be the surviving row because plan_id lives on the order, and
 * plan_id is what the page, the perks box, the admin list and the allocator all
 * read. Leaving the parent active would show a customer who just paid for the VOIP
 * week a rental still labelled "1 ngày", and would hand the next extension the old
 * plan's rules.
 *
 * The account moves only when it has to. A plan with no tag requirement is served
 * by the login the customer already has — same credentials, nothing to re-do. The
 * VOIP week requires a vetted no_ban account, so a rental on an ordinary one is
 * given a different login here, and the old account goes back to the pool.
 *
 * Deliberately does NOT sweep first, for the same reason fulfilExtension does not:
 * a sweep would expire the parent and free its account moments before we take it
 * over.
 */
async function fulfilUpgrade(env, order) {
  const db = env.DB;
  const ts = now();

  const parent = await db
    .prepare(`SELECT * FROM orders WHERE order_code = ?`)
    .bind(order.upgrades_order)
    .first();

  const stall = async (reason) => {
    await db
      .prepare(`UPDATE orders SET status = 'awaiting_stock', paid_at = COALESCE(paid_at, ?) WHERE order_code = ?`)
      .bind(ts, order.order_code)
      .run();
    return { ok: false, reason };
  };

  if (!parent || parent.user_key !== order.user_key) return stall('unknown_parent');
  if (parent.account_id == null) return stall('parent_has_no_account');

  const toPlan = findPlan(order.game, order.plan_id);
  const fromPlan = findPlan(parent.game, parent.plan_id);
  if (!toPlan || !fromPlan) return stall('unknown_plan');

  // Re-derived here rather than trusted from checkout: the row has been sitting in
  // 'pending' while the customer paid, and the rental may have been extended in the
  // meantime. Recomputing means the Math.max in upgradeQuote sees the expiry as it
  // is now, so an extension bought mid-payment is not silently swallowed.
  const { expiresAt } = upgradeQuote(fromPlan, toPlan, parent, ts);

  const heldAccount = await db
    .prepare(`SELECT id, internal_note FROM steam_accounts WHERE id = ?`)
    .bind(parent.account_id)
    .first();

  let accountId = parent.account_id;
  let swapped = null;

  const keepsAccount = accountMeetsPlanTags(heldAccount?.internal_note, toPlan.id);

  // The parent may have lapsed while the payment settled, in which case the sweep
  // has already handed its account back to the pool. Take it back before building
  // the rental on top of it — without this, an upgrade paid a minute after expiry
  // could be handed an account somebody else has since been given. Only matters
  // when the login is being kept; a swap is getting a different one anyway.
  //
  // The same reclaim fulfilExtension does, and for the same reason.
  if (keepsAccount && parent.status !== 'active') {
    const reclaimed = await db
      .prepare(
        `UPDATE steam_accounts SET status = 'rented'
          WHERE id = ? AND status = 'available'
          RETURNING id`
      )
      .bind(parent.account_id)
      .first();
    if (!reclaimed) return stall('account_taken');
    accountId = reclaimed.id;
  }

  if (!keepsAccount) {
    // Claim first, release second. The other order would leave the customer with no
    // account at all for as long as the claim takes, and if the claim then failed
    // they would have paid to lose their rental.
    const claimed = await claimAccount(db, order.game, order.user_email ?? null, toPlan.id);
    // Paid, but nothing eligible left — checkout checked the stock, so this is the
    // narrow race where the last one went to somebody else between the two moments.
    // The customer keeps the account and the plan they already had; a human refunds
    // or finds a login, which is the same handling every other out-of-stock payment
    // gets.
    if (!claimed) return stall('out_of_stock');
    swapped = { from: parent.account_id, to: claimed };
    accountId = claimed;
  }

  const writes = [
    // The upgrade becomes the live rental.
    db
      .prepare(
        `UPDATE orders SET status = 'active', paid_at = COALESCE(paid_at, ?), account_id = ?, expires_at = ?
          WHERE order_code = ?`
      )
      .bind(ts, accountId, expiresAt, order.order_code),
    // ...and the rental it replaces stops being one. expires_at goes NULL, the same
    // as a sold parent: the sweep, the reminders and the stock forecast all filter
    // on `expires_at IS NOT NULL`, so a cleared expiry drops out of every one of
    // them rather than firing later and handing the new rental's account back to
    // the pool.
    db
      .prepare(`UPDATE orders SET status = 'upgraded', expires_at = NULL WHERE order_code = ?`)
      .bind(parent.order_code),
  ];
  if (swapped) {
    // Freed only after the new one is held, and only if this rental is still what
    // is on it — an account already re-let to somebody else must not be touched.
    writes.push(
      db
        .prepare(`UPDATE steam_accounts SET status = 'available' WHERE id = ? AND status = 'rented'`)
        .bind(swapped.from)
    );
  }
  await db.batch(writes);

  return { ok: true, order: { ...order, status: 'active', account_id: accountId }, expiresAt, swapped };
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
      // payOS knows the lead's code, never a sibling's — a sibling carries no
      // payment of its own. Ask about the lead, and fulfilling it sweeps up the
      // whole batch including this row.
      const askFor = order.batch_of ?? order.order_code;
      const info = await getPaymentInfo(env, askFor);
      if (isPaid(info)) {
        await fulfilOrder(env, askFor);
      } else if (info?.status === 'CANCELLED' || info?.status === 'EXPIRED') {
        // Kept apart so the page can say "you cancelled" rather than the
        // misleading "your payment link ran out", and vice versa.
        const status = info.status === 'EXPIRED' ? 'payment_expired' : 'cancelled';
        await env.DB.prepare(`UPDATE orders SET status = ? WHERE order_code = ? AND status = 'pending'`)
          .bind(status, order.order_code)
          .run();
        // The siblings share that one payment, so they died with it. Leaving them
        // pending would show the customer rows they can never pay for.
        await env.DB.prepare(
          `UPDATE orders SET status = ? WHERE batch_of = ? AND status = 'pending'`
        )
          .bind(status, askFor)
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

/**
 * The upgrade buttons to show on one live rental.
 *
 * Everything here is decided server-side because the page cannot know any of it:
 * the price is a difference between two plans, whether the login changes depends on
 * the tags of the account this customer is holding, and whether the move is
 * possible at all depends on stock the page never sees. Sending a ready-made list
 * also means the page cannot offer a move the checkout would refuse.
 */
async function upgradeOffers(db, order, account, forEmail) {
  const fromPlan = findPlan(order.game, order.plan_id);
  if (!fromPlan) return [];
  const ts = now();

  const offers = [];
  for (const toPlanId of upgradesFrom(order.plan_id)) {
    const toPlan = findPlan(order.game, toPlanId);
    if (!toPlan) continue;
    const quote = upgradeQuote(fromPlan, toPlan, order, ts);
    // A pair with no gap between its prices cannot be charged; checkout refuses it
    // too, so it is left out rather than shown as a 0đ button.
    if (quote.amount <= 0) continue;
    const swapsAccount = !accountMeetsPlanTags(account.internal_note, toPlanId);
    offers.push({
      id: toPlan.id,
      label: toPlan.label,
      icon: toPlan.icon ?? null,
      perks: toPlan.perks ?? null,
      // The charge, not the plan's shelf price — that is the whole point.
      amount: quote.amount,
      fullAmount: toPlan.amount,
      expiresAt: quote.expiresAt,
      swapsAccount,
      // Only asked when a swap is needed: the answer is otherwise irrelevant, and
      // it is a query per plan per rental.
      available: swapsAccount ? (await countStock(db, order.game, forEmail, toPlanId)) > 0 : true,
    });
  }
  return offers;
}

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
      // An upgrade carries both; this is what makes it distinguishable from an
      // extension, in the page as well as in fulfilment.
      upgradesOrder: order.upgrades_order ?? null,
      checkoutUrl: order.status === 'pending' ? order.checkout_url : null,
      createdAt: order.created_at,
      expiresAt: order.expires_at,
      purchase: Boolean(findPlan(order.game, order.plan_id)?.purchase),
      // Both set below, once the account behind a live rental is known.
      forSale: false,
      upgrades: [],
      credentials: null,
    };

    // Credentials are released only for this user's own live rental — or, for a
    // purchase, for as long as they own it.
    if (order.status === 'active' && order.account_id != null) {
      const account = await db
        .prepare(
          `SELECT login, password_enc, note, internal_note, email, email_password_enc
             FROM steam_accounts WHERE id = ?`
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
          // A boolean, never the note text: internal_note is shop bookkeeping and
          // holds things like red_flag and prices. This only says whether the page
          // should offer the "get my Guard code" button.
          entry.guardCode = hasGuardFlag(account.note, account.internal_note);
          // Likewise a boolean, not the note: whether the buy-out button belongs on
          // this rental at all. Only a vetted no_ban account is for sale, so the
          // page leaves the button off the rest instead of offering a 190k
          // purchase that createCheckout would then refuse.
          entry.forSale = saleAllowed(account.internal_note);
          // What this rental can be moved up to, priced and stock-checked per
          // rental rather than per plan: the difference depends on what they are
          // on now, and whether a login has to change depends on the account they
          // happen to be holding.
          entry.upgrades = await upgradeOffers(db, order, account, user?.email ?? null);
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
