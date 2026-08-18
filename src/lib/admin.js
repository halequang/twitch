/**
 * Shop-owner admin: manage the Steam account pool and inspect orders.
 *
 * Authorisation reuses the existing Google/Apple session — an admin is simply a
 * signed-in user whose identity appears in ADMIN_EMAILS. It FAILS CLOSED: with
 * the var unset nobody is an admin, so a misconfigured deploy locks the panel
 * rather than opening it to every logged-in customer.
 *
 * Steam passwords are never included in list responses. Revealing one is a
 * separate, explicit call so it cannot leak into a page load or a log.
 *
 * Env:
 *   ADMIN_EMAILS  comma-separated. Entries are either an email
 *                 ("me@shop.vn") or a provider-scoped id ("google:1234").
 */

import { decryptSecret, encryptSecret } from './rentals.js';
import { DEFAULT_GAME } from '../data/rental-plans.js';
import { pendingExpiryNotices, telegramConfigured } from './notify.js';

export const ADMIN_PREFIX = '/api/admin/';

function adminList(env) {
  return String(env?.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether this session may use the admin panel. No list means no admins. */
export function isAdmin(user, env) {
  if (!user) return false;
  const allowed = adminList(env);
  if (!allowed.length) return false;
  const email = String(user.email || '').toLowerCase();
  const scoped = `${user.provider || ''}:${user.sub || ''}`.toLowerCase();
  return (email && allowed.includes(email)) || allowed.includes(scoped);
}

const now = () => Math.floor(Date.now() / 1000);

function bad(error, status = 400, extra = {}) {
  return { status, body: { error, ...extra } };
}

/** Trim, drop control characters, and cap length. */
function cleanText(value, max = 200) {
  if (value == null) return null;
  const s = Array.from(String(value))
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c > 31 && c !== 127;
    })
    .join('')
    .trim();
  return s ? s.slice(0, max) : null;
}

/* ─── accounts ────────────────────────────────── */

// Deliberately omits password_enc / email_password_enc: a listing must never
// carry credentials, encrypted or not.
const ACCOUNT_COLUMNS = `
  a.id, a.game, a.login, a.email, a.note, a.internal_note, a.status, a.created_at,
  (a.email_password_enc IS NOT NULL) AS has_email_password,
  o.order_code AS rented_order, o.user_key AS rented_by, o.user_email AS rented_email,
  o.expires_at AS rented_until`;

const ACCOUNT_FROM = `
  FROM steam_accounts a
  LEFT JOIN orders o ON o.account_id = a.id AND o.status = 'active'`;

async function listAccounts(env) {
  const rows = await env.DB.prepare(`SELECT ${ACCOUNT_COLUMNS} ${ACCOUNT_FROM} ORDER BY a.id`).all();
  return (rows?.results ?? []).map((r) => ({
    id: r.id,
    game: r.game,
    login: r.login,
    email: r.email ?? null,
    note: r.note ?? null,
    internalNote: r.internal_note ?? null,
    status: r.status,
    createdAt: r.created_at,
    hasEmailPassword: Boolean(r.has_email_password),
    rental: r.rented_order
      ? {
          orderCode: r.rented_order,
          userKey: r.rented_by,
          // Nullable: orders.user_email is whatever the provider gave at
          // checkout, and Apple accounts can have none. Callers should fall
          // back to userKey.
          userEmail: r.rented_email ?? null,
          expiresAt: r.rented_until,
        }
      : null,
  }));
}

async function createAccount(env, body) {
  const login = cleanText(body?.login, 100);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!login) return bad('login_required');
  if (!password) return bad('password_required');

  const game = cleanText(body?.game, 50) || DEFAULT_GAME;
  const exists = await env.DB.prepare(`SELECT id FROM steam_accounts WHERE game = ? AND login = ?`)
    .bind(game, login)
    .first();
  if (exists) return bad('duplicate_login', 409, { id: exists.id });

  const emailPassword = typeof body?.emailPassword === 'string' ? body.emailPassword : '';
  await env.DB.prepare(
    `INSERT INTO steam_accounts
       (game, login, password_enc, note, status, created_at, email, email_password_enc, internal_note)
     VALUES (?, ?, ?, ?, 'available', ?, ?, ?, ?)`
  )
    .bind(
      game,
      login,
      await encryptSecret(password, env.ACCOUNT_ENC_KEY),
      cleanText(body?.note, 300),
      now(),
      cleanText(body?.email, 200),
      emailPassword ? await encryptSecret(emailPassword, env.ACCOUNT_ENC_KEY) : null,
      cleanText(body?.internalNote, 300)
    )
    .run();

  return { status: 200, body: { ok: true, accounts: await listAccounts(env) } };
}

async function updateAccount(env, id, body) {
  const account = await env.DB.prepare(`SELECT * FROM steam_accounts WHERE id = ?`).bind(id).first();
  if (!account) return bad('unknown_account', 404);

  const sets = [];
  const binds = [];
  const push = (sql, value) => {
    sets.push(sql);
    binds.push(value);
  };

  if (body?.login !== undefined) {
    const login = cleanText(body.login, 100);
    if (!login) return bad('login_required');
    const clash = await env.DB.prepare(
      `SELECT id FROM steam_accounts WHERE game = ? AND login = ? AND id != ?`
    )
      .bind(account.game, login, id)
      .first();
    if (clash) return bad('duplicate_login', 409, { id: clash.id });
    push('login = ?', login);
  }
  if (body?.email !== undefined) push('email = ?', cleanText(body.email, 200));
  if (body?.note !== undefined) push('note = ?', cleanText(body.note, 300));
  if (body?.internalNote !== undefined) push('internal_note = ?', cleanText(body.internalNote, 300));

  if (body?.status !== undefined) {
    const status = String(body.status);
    if (!['available', 'rented', 'disabled'].includes(status)) return bad('bad_status');
    // Freeing an account while a rental still holds it would hand the same login
    // to a second customer.
    if (status === 'available' && account.status === 'rented') {
      const live = await env.DB.prepare(
        `SELECT order_code FROM orders WHERE account_id = ? AND status = 'active'`
      )
        .bind(id)
        .first();
      if (live) return bad('rental_active', 409, { orderCode: live.order_code });
    }
    push('status = ?', status);
  }

  // Empty string means "leave unchanged" — only a non-empty value re-encrypts.
  if (body?.password) {
    push('password_enc = ?', await encryptSecret(String(body.password), env.ACCOUNT_ENC_KEY));
  }
  // Same rule as the Steam password: "" means leave it alone, so a form that
  // always submits the field cannot silently wipe a stored mail password.
  // Clearing it deliberately is an explicit null.
  if (body?.emailPassword !== undefined && body.emailPassword !== '') {
    push(
      'email_password_enc = ?',
      body.emailPassword === null ? null : await encryptSecret(String(body.emailPassword), env.ACCOUNT_ENC_KEY)
    );
  }

  if (!sets.length) return bad('nothing_to_update');

  binds.push(id);
  await env.DB.prepare(`UPDATE steam_accounts SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  return { status: 200, body: { ok: true, accounts: await listAccounts(env) } };
}

async function deleteAccount(env, id, force) {
  const account = await env.DB.prepare(`SELECT id, status FROM steam_accounts WHERE id = ?`)
    .bind(id)
    .first();
  if (!account) return bad('unknown_account', 404);

  // Deleting an account someone is currently renting would strip the login from
  // a paying customer mid-rental, so it takes an explicit override.
  const live = await env.DB.prepare(
    `SELECT order_code, expires_at FROM orders WHERE account_id = ? AND status = 'active'`
  )
    .bind(id)
    .first();
  if (live && !force) {
    return bad('rental_active', 409, { orderCode: live.order_code, expiresAt: live.expires_at });
  }

  // Orders keep account_id only as a historical reference, so null it rather
  // than cascade-deleting — order history must survive.
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET account_id = NULL WHERE account_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM steam_accounts WHERE id = ?`).bind(id),
  ]);

  return { status: 200, body: { ok: true, accounts: await listAccounts(env) } };
}

/** Explicit, separate call — credentials never ride along with a listing. */
async function revealAccount(env, id) {
  const row = await env.DB.prepare(
    `SELECT login, password_enc, email, email_password_enc FROM steam_accounts WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!row) return bad('unknown_account', 404);

  try {
    return {
      status: 200,
      body: {
        login: row.login,
        password: await decryptSecret(row.password_enc, env.ACCOUNT_ENC_KEY),
        email: row.email ?? null,
        emailPassword: row.email_password_enc
          ? await decryptSecret(row.email_password_enc, env.ACCOUNT_ENC_KEY)
          : null,
      },
    };
  } catch {
    return bad('decrypt_failed', 500, {
      hint: 'ACCOUNT_ENC_KEY does not match the key this row was encrypted with',
    });
  }
}

/* ─── orders ──────────────────────────────────── */

async function listAllOrders(env, limit) {
  const rows = await env.DB.prepare(
    `SELECT o.*, a.login AS account_login
       FROM orders o
       LEFT JOIN steam_accounts a ON a.id = o.account_id
      ORDER BY o.created_at DESC
      LIMIT ?`
  )
    .bind(Math.min(Number(limit) || 100, 500))
    .all();

  return (rows?.results ?? []).map((o) => ({
    orderCode: o.order_code,
    userKey: o.user_key,
    userEmail: o.user_email ?? null,
    game: o.game,
    planId: o.plan_id,
    hours: o.hours,
    amount: o.amount,
    status: o.status,
    accountLogin: o.account_login ?? null,
    extendsOrder: o.extends_order ?? null,
    createdAt: o.created_at,
    paidAt: o.paid_at ?? null,
    expiresAt: o.expires_at ?? null,
  }));
}

async function summary(env) {
  return (
    (await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM steam_accounts) AS accounts,
         (SELECT COUNT(*) FROM steam_accounts WHERE status = 'available') AS available,
         (SELECT COUNT(*) FROM steam_accounts WHERE status = 'rented') AS rented,
         (SELECT COUNT(*) FROM steam_accounts WHERE status = 'disabled') AS disabled,
         (SELECT COUNT(*) FROM orders WHERE status = 'active') AS activeRentals,
         (SELECT COUNT(*) FROM orders WHERE status = 'awaiting_stock') AS awaitingStock,
         (SELECT COALESCE(SUM(amount), 0) FROM orders WHERE paid_at IS NOT NULL) AS revenue`
    ).first()) ?? {}
  );
}

/* ─── routing ─────────────────────────────────── */

/**
 * Handles /api/admin/*. Re-checks admin rights itself, so no route can be
 * reached unauthorised even if the caller forgets.
 *
 * @returns {{ status: number, body: object }}
 */
export async function handleAdminRequest(env, { path, method, body, user, query }) {
  // Lets the page decide what to render. Safe for anyone to call: it reveals
  // only whether YOU are an admin.
  if (path === '/api/admin/session') {
    return { status: 200, body: { admin: isAdmin(user, env), email: user?.email ?? null } };
  }

  if (!user) return bad('unauthorized', 401);
  if (!isAdmin(user, env)) return bad('forbidden', 403);
  if (!env.DB || !env.ACCOUNT_ENC_KEY) return bad('rentals_not_configured', 503);

  if (path === '/api/admin/summary' && method === 'GET') {
    return { status: 200, body: await summary(env) };
  }

  // Rentals that ended and still need their Steam password rotated. Shown in the
  // panel as well as pushed to Telegram, so the queue is visible even when the
  // bot is not configured.
  if (path === '/api/admin/expired' && method === 'GET') {
    const rows = await pendingExpiryNotices(env, query?.limit);
    return {
      status: 200,
      body: {
        telegram: telegramConfigured(env),
        pending: rows.map((r) => ({
          orderCode: r.order_code,
          userEmail: r.user_email ?? null,
          userKey: r.user_key,
          planId: r.plan_id,
          hours: r.hours,
          expiresAt: r.expires_at,
          accountLogin: r.account_login ?? null,
        })),
      },
    };
  }

  if (path === '/api/admin/orders' && method === 'GET') {
    return { status: 200, body: { orders: await listAllOrders(env, query?.limit) } };
  }

  if (path === '/api/admin/accounts') {
    if (method === 'GET') return { status: 200, body: { accounts: await listAccounts(env) } };
    if (method === 'POST') return createAccount(env, body);
    return bad('method_not_allowed', 405);
  }

  const match = /^\/api\/admin\/accounts\/(\d+)(\/reveal)?$/.exec(path);
  if (match) {
    const id = Number(match[1]);
    if (match[2]) {
      if (method !== 'POST') return bad('method_not_allowed', 405);
      return revealAccount(env, id);
    }
    if (method === 'PATCH' || method === 'POST') return updateAccount(env, id, body);
    if (method === 'DELETE') return deleteAccount(env, id, query?.force === '1');
    return bad('method_not_allowed', 405);
  }

  return bad('not_found', 404);
}
